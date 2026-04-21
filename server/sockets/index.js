import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import Document from "../models/docs.models.js";
import OperationLog from "../models/operationLog.models.js";
import { transformAgainstPriors } from "../utils/operationalTransform.utils.js";

const OPERATION_DEBOUNCE_MS = Number(process.env.OPERATION_DEBOUNCE_MS || 120);
const pendingOperationBatches = new Map();
const activeCursors = new Map();

const getCursorKey = (socketId, documentId) => `${documentId}:${socketId}`;
const getBatchKey = (socketId, documentId) => `${socketId}:${documentId}`;

const parseCookieHeader = (cookieHeader = "") => {
  return cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce((acc, cookiePart) => {
      const separatorIndex = cookiePart.indexOf("=");
      if (separatorIndex === -1) {
        return acc;
      }

      const key = cookiePart.slice(0, separatorIndex).trim();
      const value = cookiePart.slice(separatorIndex + 1).trim();
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
};

const getTokenFromSocket = (socket) => {
  const authToken = socket.handshake.auth?.token;
  if (authToken) {
    return authToken;
  }

  const authHeader = socket.handshake.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.split(" ")[1];
  }

  const cookies = parseCookieHeader(socket.handshake.headers?.cookie || "");
  if (cookies.token) {
    return cookies.token;
  }

  return null;
};

const flushOperationBatch = async (io, batchKey) => {
  const batch = pendingOperationBatches.get(batchKey);
  if (!batch) {
    return;
  }

  pendingOperationBatches.delete(batchKey);

  if (batch.timer) {
    clearTimeout(batch.timer);
  }

  const { socket, documentId, userId, operations } = batch;

  if (!operations.length) {
    return;
  }

  try {
    const doc = await Document.findById(documentId);
    if (!doc) {
      return socket.emit("operation-error", "Document not found");
    }

    if (doc.owner.toString() !== userId) {
      return socket.emit("operation-error", "Access denied");
    }

    const baseVersion = operations[0].version;
    
    // Check if there's a version mismatch (conflict scenario)
    if (doc.version !== baseVersion) {
      // Fetch all operations since the client's base version
      const priorOps = await OperationLog.find({
        documentId,
        version: { $gte: baseVersion, $lt: doc.version },
      }).sort({ version: 1, timestamp: 1 });

      // Transform incoming operations against prior operations
      const transformedOps = transformAgainstPriors(operations, priorOps);

      // Validate transformed operations
      let nextContent = doc.content;
      for (let index = 0; index < transformedOps.length; index += 1) {
        const operation = transformedOps[index];

        if (operation.type !== "insert" && operation.type !== "delete") {
          return socket.emit("operation-error", "Only insert and delete operations are supported");
        }

        if (
          typeof operation.position !== "number" ||
          operation.position < 0 ||
          operation.position > nextContent.length
        ) {
          return socket.emit("operation-error", "Invalid transformed operation position");
        }

        if (operation.type === "insert") {
          if (typeof operation.text !== "string") {
            return socket.emit("operation-error", "Operation text is required for insert");
          }
          nextContent =
            nextContent.slice(0, operation.position) +
            operation.text +
            nextContent.slice(operation.position);
        }

        if (operation.type === "delete") {
          if (
            !Number.isInteger(operation.length) ||
            operation.length <= 0 ||
            operation.position + operation.length > nextContent.length
          ) {
            return socket.emit("operation-error", "Invalid delete length");
          }
          nextContent =
            nextContent.slice(0, operation.position) +
            nextContent.slice(operation.position + operation.length);
        }
      }

      // Apply transformed operations with atomic update
      const updatedDoc = await Document.findByIdAndUpdate(
        documentId,
        {
          $set: { content: nextContent },
          $inc: { version: transformedOps.length },
        },
        { new: true },
      );

      if (!updatedDoc) {
        const latestDoc = await Document.findById(documentId);
        return socket.emit("resync-required", {
          documentId,
          serverVersion: latestDoc?.version,
          clientVersion: baseVersion,
          content: latestDoc?.content ?? "",
        });
      }

      // Log transformed operations
      const newVersion = baseVersion;
      for (let index = 0; index < transformedOps.length; index += 1) {
        const op = transformedOps[index];
        await OperationLog.create({
          documentId,
          userId,
          type: op.type,
          position: op.position,
          text: op.text || "",
          length: op.length || 0,
          version: newVersion + index + 1,
          timestamp: new Date(),
        });
      }

      // Emit transformed operations to all clients
      for (let index = 0; index < transformedOps.length; index += 1) {
        const op = transformedOps[index];
        socket.to(documentId).emit("receive-operation", {
          ...op,
          version: baseVersion + index + 1,
          transformed: true,
          originalVersion: baseVersion,
        });
      }

      // Emit conflict-resolved acknowledgment to the sender
      socket.emit("operation-ack", {
        documentId,
        version: updatedDoc.version,
        appliedOperations: transformedOps.length,
        transformed: true,
        transformations: transformedOps.map((op, idx) => ({
          originalVersion: baseVersion,
          newVersion: baseVersion + idx + 1,
          positionChanged: op.position !== operations[idx].position,
          newPosition: op.position,
        })),
      });

      return;
    }

    // No conflict: standard path
    // Validate all operations
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index];
      const expectedVersion = baseVersion + index;
      if (operation.version !== expectedVersion) {
        return socket.emit("resync-required", {
          documentId,
          serverVersion: doc.version,
          clientVersion: operation.version,
          content: doc.content,
        });
      }
    }

    let nextContent = doc.content;

    for (const operation of operations) {
      if (operation.type !== "insert" && operation.type !== "delete") {
        return socket.emit("operation-error", "Only insert and delete operations are supported");
      }

      if (
        typeof operation.position !== "number" ||
        operation.position < 0 ||
        operation.position > nextContent.length
      ) {
        return socket.emit("operation-error", "Invalid operation position");
      }

      if (operation.type === "insert") {
        if (typeof operation.text !== "string") {
          return socket.emit("operation-error", "Operation text is required for insert");
        }

        nextContent =
          nextContent.slice(0, operation.position) +
          operation.text +
          nextContent.slice(operation.position);
      }

      if (operation.type === "delete") {
        if (
          !Number.isInteger(operation.length) ||
          operation.length <= 0 ||
          operation.position + operation.length > nextContent.length
        ) {
          return socket.emit("operation-error", "Invalid delete length");
        }

        nextContent =
          nextContent.slice(0, operation.position) +
          nextContent.slice(operation.position + operation.length);
      }
    }

    const updatedDoc = await Document.findOneAndUpdate(
      { _id: documentId, version: baseVersion },
      {
        $set: { content: nextContent },
        $inc: { version: operations.length },
      },
      { new: true },
    );

    if (!updatedDoc) {
      const latestDoc = await Document.findById(documentId);
      return socket.emit("resync-required", {
        documentId,
        serverVersion: latestDoc?.version,
        clientVersion: baseVersion,
        content: latestDoc?.content ?? "",
      });
    }

    // Log operations
    for (let index = 0; index < operations.length; index += 1) {
      const op = operations[index];
      await OperationLog.create({
        documentId,
        userId,
        type: op.type,
        position: op.position,
        text: op.text || "",
        length: op.length || 0,
        version: baseVersion + index + 1,
        timestamp: new Date(),
      });
    }

    // Broadcast operations
    for (let index = 0; index < operations.length; index += 1) {
      const op = operations[index];
      socket.to(documentId).emit("receive-operation", {
        ...op,
        version: baseVersion + index + 1,
      });
    }

    socket.emit("operation-ack", {
      documentId,
      version: updatedDoc.version,
      appliedOperations: operations.length,
    });
  } catch (error) {
    console.error("Error flushing operation batch:", error);
    socket.emit("operation-error", "Failed to send operation");
  }
};

const registerSocketHandlers = (io) => {
  io.use((socket, next) => {
    try {
      const token = getTokenFromSocket(socket);

      if (!token) {
        return next(new Error("Unauthorized: token missing"));
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      socket.user = decoded;

      console.log("Authenticated user:", decoded.id);

      next();
    } catch (err) {
      next(new Error("Unauthorized: token invalid or expired"));
    }
  });

  io.on("connection", (socket) => {
    console.log("A user connected: " + socket.id);

    socket.on("join-document", async (documentId) => {
      const userId = socket.user?.id;

      try {
        console.log(`User ${userId} wants to join document ${documentId}`);

        const doc = await Document.findById(documentId);
        if (!doc) {
          return socket.emit("document-error", "Document not found");
        }

        if (doc.owner.toString() !== userId) {
          return socket.emit(
            "document-error",
            "Access denied: you can only join documents you own",
          );
        }

        socket.join(documentId);
        console.log(`User ${userId} joined document ${documentId}`);

        const cursorsInDoc = [];
        for (const [key, cursor] of activeCursors) {
          if (key.startsWith(`${documentId}:`)) {
            cursorsInDoc.push(cursor);
          }
        }
        socket.emit("load-cursors", cursorsInDoc);

        socket.emit("load-document", {
          documentId,
          name: doc.name,
          description: doc.description,
          content: doc.content,
          version: doc.version,
        });

        socket.to(documentId).emit("cursor-update", {
          userId,
          socketId: socket.id,
          documentId,
          position: 0,
        });
      } catch (err) {
        console.error("Error joining document:", err);
        socket.emit("document-error", "Failed to join document");
      }
    });

    socket.on("send-cursor", (documentId, cursorData) => {
      const userId = socket.user?.id;
      const cursorKey = getCursorKey(socket.id, documentId);

      if (!cursorData || typeof cursorData !== "object") {
        return socket.emit("operation-error", "Invalid cursor data");
      }

      if (typeof cursorData.position !== "number" || cursorData.position < 0) {
        return socket.emit("operation-error", "Cursor position must be a non-negative number");
      }

      activeCursors.set(cursorKey, {
        userId,
        socketId: socket.id,
        documentId,
        position: cursorData.position,
        timestamp: Date.now(),
      });

      socket.to(documentId).emit("cursor-update", {
        userId,
        socketId: socket.id,
        documentId,
        position: cursorData.position,
        timestamp: Date.now(),
      });
    });

    socket.on("send-operation", async (documentId, operation) => {
      const userId = socket.user?.id;

      if (!operation || typeof operation !== "object") {
        return socket.emit("operation-error", "Invalid operation payload");
      }

      if (typeof operation.version !== "number") {
        return socket.emit("operation-error", "Operation version is required");
      }

      if (operation.type !== "insert" && operation.type !== "delete") {
        return socket.emit("operation-error", "Only insert and delete operations are supported");
      }

      if (typeof operation.position !== "number") {
        return socket.emit("operation-error", "Operation position is required");
      }

      if (operation.type === "insert" && typeof operation.text !== "string") {
        return socket.emit("operation-error", "Operation text is required for insert");
      }

      if (
        operation.type === "delete" &&
        (!Number.isInteger(operation.length) || operation.length <= 0)
      ) {
        return socket.emit("operation-error", "Delete length must be a positive integer");
      }

      const batchKey = getBatchKey(socket.id, documentId);
      const existingBatch = pendingOperationBatches.get(batchKey);

      if (!existingBatch) {
        const timer = setTimeout(() => {
          flushOperationBatch(io, batchKey);
        }, OPERATION_DEBOUNCE_MS);

        pendingOperationBatches.set(batchKey, {
          socket,
          documentId,
          userId,
          operations: [operation],
          timer,
        });
        return;
      }

      existingBatch.operations.push(operation);

      if (existingBatch.timer) {
        clearTimeout(existingBatch.timer);
      }

      existingBatch.timer = setTimeout(() => {
        flushOperationBatch(io, batchKey);
      }, OPERATION_DEBOUNCE_MS);
    });

    socket.on("receive-operation", async (op) => {
      console.log("Received Operation !", op);
    });

    socket.on("leave-document", (documentId) => {
      const userId = socket.user?.id;
      const batchKey = getBatchKey(socket.id, documentId);
      const cursorKey = getCursorKey(socket.id, documentId);

      flushOperationBatch(io, batchKey);
      activeCursors.delete(cursorKey);

      console.log(`User ${userId} wants to leave document ${documentId}`);
      socket.leave(documentId);

      socket.to(documentId).emit("cursor-removed", {
        socketId: socket.id,
        documentId,
      });
    });

    socket.on("disconnect", () => {
      for (const key of pendingOperationBatches.keys()) {
        if (key.startsWith(`${socket.id}:`)) {
          flushOperationBatch(io, key);
        }
      }

      for (const key of activeCursors.keys()) {
        if (key.endsWith(`:${socket.id}`)) {
          activeCursors.delete(key);
        }
      }

      console.log("A user disconnected: " + socket.id);
    });
  });
};

const initializeSocketServer = (server) => {
  const io = new Server(server, {
    cors: {
      origin: "https://real-time-multi-user-distributed-sy.vercel.app",
      credentials: true,
    },
  });

  registerSocketHandlers(io);
  return io;
};

export default initializeSocketServer;