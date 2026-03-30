import dotenv from "dotenv";
import { io } from "socket.io-client";

dotenv.config();

const SERVER_URL = process.env.SERVER_URL;
const TOKEN = process.env.TOKEN;
const DOCUMENT_ID = process.env.DOCUMENT_ID;
const INSERT_TEXT = "HELLO_MY_NAME_IS_TESTER";
const DELETE_COUNT = 10;
const BURST_INTERVAL_MS = Number(process.env.BURST_INTERVAL_MS || 15);
const START_DELAY_MS = Number(process.env.START_DELAY_MS || 700);
const CLIENT_DEBOUNCE_MS = Number(process.env.CLIENT_DEBOUNCE_MS || 80);

// console.log(SERVER_URL, TOKEN, DOCUMENT_ID);

if (!TOKEN || !DOCUMENT_ID) {
  console.error("Missing env vars: TOKEN and DOCUMENT_ID are required");
  process.exit(1);
}

const clientA = io(SERVER_URL, { auth: { token: TOKEN } });
const clientB = io(SERVER_URL, { auth: { token: TOKEN } });

let aJoined = false;
let bJoined = false;
let hasStartedBurst = false;
let baseVersion = 0;
let baseContentLength = 0;
let baseContent = "";
let expectedAckVersion = 0;
let expectedOperationCount = 0;
let expectedNetSuffix = "";
let ackOk = false;
let bReceivedCount = 0;
let bVersionsAreSequential = true;
let lastReceivedVersion = null;
let clientOutbox = [];
let clientFlushTimer = null;
let localVersionCursor = 0;
let localContentLength = 0;
let bCurrentContent = "";
let aCursorPosition = 0;
let bCursorPosition = 0;
let remoteCursorsA = new Map();
let remoteCursorsB = new Map();
const cleanupAndExit = (code) => {
  if (clientFlushTimer) {
    clearTimeout(clientFlushTimer);
  }

  clientA.disconnect();
  clientB.disconnect();
  process.exit(code);
};

const flushClientOutbox = () => {
  if (!clientOutbox.length) {
    return;
  }

  const queuedOperations = clientOutbox;
  clientOutbox = [];

  console.log(`A flushing ${queuedOperations.length} queued operations`);

  for (const operation of queuedOperations) {
    console.log("A emitted operation:", operation);
    clientA.emit("send-operation", DOCUMENT_ID, operation);
  }
  
  // Send final cursor position
  sendCursorUpdate(clientA, aCursorPosition);
};

const scheduleClientFlush = () => {
  if (clientFlushTimer) {
    clearTimeout(clientFlushTimer);
  }

  clientFlushTimer = setTimeout(() => {
    clientFlushTimer = null;
    flushClientOutbox();
  }, CLIENT_DEBOUNCE_MS);
};

const sendCursorUpdate = (socket, position) => {
  socket.emit("send-cursor", DOCUMENT_ID, { position });
};

const queueLocalInsertOperation = (char) => {
  const operation = {
    type: "insert",
    position: localContentLength,
    text: char,
    version: localVersionCursor,
  };

  localContentLength += 1;
  localVersionCursor += 1;
  aCursorPosition = localContentLength;
  clientOutbox.push(operation);

  console.log("A queued local operation:", operation);
  console.log(`A cursor position: ${aCursorPosition}`);
  scheduleClientFlush();
};

const queueLocalDeleteOperation = (length = 1) => {
  if (!Number.isInteger(length) || length <= 0 || length > localContentLength) {
    console.error("Skipping invalid local delete length:", length);
    return;
  }

  const operation = {
    type: "delete",
    position: localContentLength - length,
    length,
    version: localVersionCursor,
  };

  localContentLength -= length;
  localVersionCursor += 1;
  aCursorPosition = localContentLength;
  clientOutbox.push(operation);

  console.log("A queued local operation:", operation);
  console.log(`A cursor position: ${aCursorPosition}`);
  scheduleClientFlush();
};

const maybeStartBurst = () => {
  if (!aJoined || !bJoined || hasStartedBurst) {
    return;
  }

  hasStartedBurst = true;
  localVersionCursor = baseVersion;
  localContentLength = baseContentLength;

  const effectiveDeleteCount = Math.min(DELETE_COUNT, INSERT_TEXT.length);
  expectedOperationCount = INSERT_TEXT.length + effectiveDeleteCount;
  expectedAckVersion = baseVersion + expectedOperationCount;
  expectedNetSuffix = INSERT_TEXT.slice(0, INSERT_TEXT.length - effectiveDeleteCount);

  setTimeout(() => {
    console.log(
      `A generating mixed burst: ${INSERT_TEXT.length} inserts + ${effectiveDeleteCount} deletes at ${BURST_INTERVAL_MS}ms interval (client debounce ${CLIENT_DEBOUNCE_MS}ms)`,
    );

    for (let index = 0; index < INSERT_TEXT.length; index += 1) {
      setTimeout(() => {
        queueLocalInsertOperation(INSERT_TEXT[index]);
      }, index * BURST_INTERVAL_MS);
    }

    for (let index = 0; index < effectiveDeleteCount; index += 1) {
      const opIndex = INSERT_TEXT.length + index;
      setTimeout(() => {
        queueLocalDeleteOperation(1);
      }, opIndex * BURST_INTERVAL_MS);
    }
  }, START_DELAY_MS);
};

const maybeFinish = () => {
  const hasExpectedSuffix = bCurrentContent.endsWith(expectedNetSuffix);

  if (
    ackOk &&
    bReceivedCount === expectedOperationCount &&
    bVersionsAreSequential &&
    hasExpectedSuffix
  ) {
    console.log("SUCCESS: debounced batch applied and propagated correctly");
    cleanupAndExit(0);
  }
};

clientA.on("connect", () => {
  console.log("A connected:", clientA.id);
  clientA.emit("join-document", DOCUMENT_ID);
});

clientB.on("connect", () => {
  console.log("B connected:", clientB.id);
  clientB.emit("join-document", DOCUMENT_ID);
});

clientA.on("load-document", async (payload) => {
  console.log("A load-document:", payload);
  baseVersion = payload?.version ?? 0;
  baseContent = payload?.content ?? "";
  baseContentLength = payload?.content?.length ?? 0;
  aJoined = true;
  maybeStartBurst();
});

clientB.on("load-document", (payload) => {
  console.log("B load-document:", payload);
  baseVersion = payload?.version ?? baseVersion;
  baseContent = payload?.content ?? baseContent;
  bCurrentContent = payload?.content ?? bCurrentContent;
  baseContentLength = payload?.content?.length ?? baseContentLength;
  bJoined = true;
  maybeStartBurst();
});

clientB.on("receive-operation", (operation) => {
  console.log("B received operation:", operation);

  bReceivedCount += 1;

  if (operation.type === "insert") {
    bCurrentContent =
      bCurrentContent.slice(0, operation.position) +
      operation.text +
      bCurrentContent.slice(operation.position);
    // Update B's cursor if insert was before or at cursor position
    if (operation.position <= bCursorPosition) {
      bCursorPosition += operation.text.length;
    }
  }

  if (operation.type === "delete") {
    bCurrentContent =
      bCurrentContent.slice(0, operation.position) +
      bCurrentContent.slice(operation.position + operation.length);
    // Update B's cursor if delete affects cursor position
    if (operation.position < bCursorPosition) {
      bCursorPosition = Math.max(operation.position, bCursorPosition - operation.length);
    }
  }

  if (lastReceivedVersion !== null && operation.version !== lastReceivedVersion + 1) {
    bVersionsAreSequential = false;
  }

  lastReceivedVersion = operation.version;
  maybeFinish();
});

clientA.on("load-cursors", (cursors) => {
  console.log("A load-cursors:", cursors);
  for (const cursor of cursors) {
    if (cursor.socketId !== clientA.id) {
      remoteCursorsA.set(cursor.socketId, cursor);
    }
  }
});

clientB.on("load-cursors", (cursors) => {
  console.log("B load-cursors:", cursors);
  for (const cursor of cursors) {
    if (cursor.socketId !== clientB.id) {
      remoteCursorsB.set(cursor.socketId, cursor);
    }
  }
});

clientA.on("cursor-update", (cursorData) => {
  console.log("A cursor-update:", cursorData);
  if (cursorData.socketId !== clientA.id) {
    remoteCursorsA.set(cursorData.socketId, cursorData);
  }
});

clientB.on("cursor-update", (cursorData) => {
  console.log("B cursor-update:", cursorData);
  if (cursorData.socketId !== clientB.id) {
    remoteCursorsB.set(cursorData.socketId, cursorData);
  }
});

clientA.on("cursor-removed", (data) => {
  console.log("A cursor-removed:", data);
  remoteCursorsA.delete(data.socketId);
});

clientB.on("cursor-removed", (data) => {
  console.log("B cursor-removed:", data);
  remoteCursorsB.delete(data.socketId);
});

clientA.on("operation-ack", (ack) => {
  console.log("A operation-ack:", ack);

  if (
    ack?.appliedOperations === expectedOperationCount &&
    ack?.version === expectedAckVersion
  ) {
    ackOk = true;
  }

  maybeFinish();
});

clientA.on("resync-required", (payload) => {
  console.error("A resync-required:", payload);
  cleanupAndExit(59);
});

clientB.on("resync-required", (payload) => {
  console.error("B resync-required:", payload);
  cleanupAndExit(60);
});

clientA.on("document-error", (msg) => console.error("A document-error:", msg));
clientB.on("document-error", (msg) => console.error("B document-error:", msg));
clientA.on("operation-error", (msg) =>
  console.error("A operation-error:", msg),
);
clientB.on("operation-error", (msg) =>
  console.error("B operation-error:", msg),
);

clientA.on("connect_error", (err) =>
  console.error("A connect_error:", err.message),
);
clientB.on("connect_error", (err) =>
  console.error("B connect_error:", err.message),
);

setTimeout(() => {
  if (!ackOk) {
    console.error("FAIL: timeout waiting for expected batch ack");
    cleanupAndExit(58);
  }

  if (bReceivedCount !== expectedOperationCount) {
    console.error(
      `FAIL: expected ${expectedOperationCount} receive-operation events, got ${bReceivedCount}`,
    );
    cleanupAndExit(61);
  }

  if (!bVersionsAreSequential) {
    console.error("FAIL: receive-operation versions were not sequential");
    cleanupAndExit(62);
  }

  if (!bCurrentContent.endsWith(expectedNetSuffix)) {
    console.error(
      `FAIL: content suffix mismatch; expected suffix "${expectedNetSuffix}"`,
    );
    cleanupAndExit(63);
  }

  console.log("SUCCESS: validations passed before timeout");
  cleanupAndExit(0);
}, 20000);