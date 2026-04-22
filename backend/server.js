import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";
import dbconnect from "./config/db.config.js";
import authRoutes from "./routes/auth.routes.js";
import docsRoutes from "./routes/docs.routes.js";
import Document from "./models/docs.models.js";
import User from "./models/user.models.js";
import http from "http";
import { Server } from "socket.io";
import jwt from "jsonwebtoken";

dotenv.config();
dbconnect();

const app = express();
const PORT = process.env.PORT || 3000;
const allowedOrigins = (process.env.CORS_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const isAllowedOrigin = (origin) => {
  if (!origin) {
    return true;
  }

  return allowedOrigins.includes(origin);
};

const corsOptions = {
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
  transports: ['websocket', 'polling'],
  pingTimeout: 60000,
  pingInterval: 25000,
  connectTimeout: 45000,
  allowEIO3: true,
});
const MAX_OPERATION_HISTORY = 1000;
const operationHistoryByDocument = new Map();

const compareOpOrder = (a, b) => {
  if (a.opId < b.opId) {
    return -1;
  }

  if (a.opId > b.opId) {
    return 1;
  }

  if ((a.userId || "") < (b.userId || "")) {
    return -1;
  }

  if ((a.userId || "") > (b.userId || "")) {
    return 1;
  }

  return 0;
};

const toNoop = (op) => ({
  ...op,
  type: "noop",
});

const transformOperation = (op1, op2) => {
  if (op2.type === "noop") {
    return op2;
  }

  const out = { ...op2 };

  const op1Insert = op1.type === "insert";
  const op1Delete = op1.type === "delete";
  const op2Insert = op2.type === "insert";
  const op2Delete = op2.type === "delete";

  if (op1Insert && op2Insert) {
    if (op1.position < out.position) {
      out.position += op1.value.length;
      return out;
    }

    if (op1.position === out.position && compareOpOrder(op1, out) < 0) {
      out.position += op1.value.length;
    }

    return out;
  }

  if (op1Insert && op2Delete) {
    const delStart = out.position;
    const delEnd = out.position + out.length;

    if (op1.position <= delStart) {
      out.position += op1.value.length;
    } else if (op1.position < delEnd) {
      out.length += op1.value.length;
    }

    return out;
  }

  if (op1Delete && op2Insert) {
    const delStart = op1.position;
    const delEnd = op1.position + op1.length;

    if (out.position > delEnd) {
      out.position -= op1.length;
    } else if (out.position > delStart && out.position <= delEnd) {
      out.position = delStart;
    }

    return out;
  }

  if (op1Delete && op2Delete) {
    const aStart = op1.position;
    const aEnd = op1.position + op1.length;
    let bStart = out.position;
    const bEnd = out.position + out.length;

    if (bEnd <= aStart) {
      return out;
    }

    if (bStart >= aEnd) {
      out.position -= op1.length;
      return out;
    }

    const overlapStart = Math.max(aStart, bStart);
    const overlapEnd = Math.min(aEnd, bEnd);
    const overlapLength = Math.max(0, overlapEnd - overlapStart);

    out.length -= overlapLength;
    if (out.length <= 0) {
      return toNoop(out);
    }

    if (bStart >= aStart) {
      bStart = aStart;
    }

    out.position = bStart;
    return out;
  }

  return out;
};

const applyOperationToContent = (content, operation) => {
  if (operation.type === "noop") {
    return content;
  }

  if (operation.type === "insert") {
    return (
      content.slice(0, operation.position) +
      operation.value +
      content.slice(operation.position)
    );
  }

  if (operation.type === "delete") {
    return (
      content.slice(0, operation.position) +
      content.slice(operation.position + operation.length)
    );
  }

  return content;
};

const getDocumentHistoryState = (documentId, currentVersion) => {
  const key = documentId.toString();
  const existing = operationHistoryByDocument.get(key);

  if (!existing) {
    const initialized = {
      baseVersion: currentVersion,
      operations: [],
    };
    operationHistoryByDocument.set(key, initialized);
    return initialized;
  }

  if (existing.baseVersion + existing.operations.length !== currentVersion) {
    existing.baseVersion = currentVersion;
    existing.operations = [];
  }

  return existing;
};

const hasDocumentAccess = (doc, userId) => {
  const isOwner = doc.owner.toString() === userId;
  const isCollaborator = doc.collaborators.some(
    (collaboratorId) => collaboratorId.toString() === userId,
  );

  return isOwner || isCollaborator;
};

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

io.use((socket, next) => {
  (async () => {
    const token = getTokenFromSocket(socket);

    if (!token) {
      return next(new Error("Unauthorized: token missing"));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select("_id name email");
      if (!user) {
        return next(new Error("Unauthorized: user not found"));
      }

      socket.user = {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
      };

      console.log("Authenticated user:", socket.user.id);

      next();
    } catch (err) {
      next(new Error("Unauthorized: token invalid or expired"));
    }
  })();
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

      if (!hasDocumentAccess(doc, userId)) {
        return socket.emit(
          "document-error",
          "Access denied: you are not a collaborator on this document",
        );
      }

      getDocumentHistoryState(documentId, doc.version);

      socket.join(documentId);
      console.log(`User ${userId} joined document ${documentId}`);
      socket.emit("load-document", {
        documentId,
        name: doc.name,
        description: doc.description,
        content: doc.content,
        version: doc.version,
      });

      const roomSockets = io.sockets.adapter.rooms.get(documentId) || new Set();
      const participants = Array.from(roomSockets)
        .map((socketId) => {
          const participantSocket = io.sockets.sockets.get(socketId);
          if (!participantSocket || socketId === socket.id) {
            return null;
          }

          return {
            socketId,
            userId: participantSocket.user?.id,
            userName: participantSocket.user?.name || "Unknown user",
          };
        })
        .filter(Boolean);

      socket.emit("presence-sync", {
        documentId,
        participants,
      });

      socket.to(documentId).emit("cursor-update", {
        documentId,
        socketId: socket.id,
        userId: socket.user?.id,
        userName: socket.user?.name || "Unknown user",
        position: 0,
      });
    } catch (err) {
      console.error("Error joining document:", err);
      socket.emit("document-error", "Failed to join document");
    }
  });

  socket.on("cursor-update", ({ documentId, position }) => {
    if (!documentId || !Number.isInteger(position) || position < 0) {
      return;
    }

    socket.to(documentId).emit("cursor-update", {
      documentId,
      socketId: socket.id,
      userId: socket.user?.id,
      userName: socket.user?.name || "Unknown user",
      position,
    });
  });

  socket.on("send-operation", async (payload) => {
    const userId = socket.user?.id;

    try {
      const { documentId, operation } = payload || {};

      if (!documentId || !operation || typeof operation !== "object") {
        return socket.emit("document-error", "Invalid operation payload");
      }

      const doc = await Document.findById(documentId);
      if (!doc) {
        return socket.emit("document-error", "Document not found");
      }

      if (!hasDocumentAccess(doc, userId)) {
        return socket.emit("document-error", "Access denied");
      }

      if (typeof operation.opId !== "string") {
        return socket.emit("document-error", "Operation opId is required");
      }

      if (typeof operation.version !== "number") {
        return socket.emit("document-error", "Operation version is required");
      }

      if (operation.type !== "insert" && operation.type !== "delete") {
        return socket.emit("document-error", "Unsupported operation type");
      }

      if (!Number.isInteger(operation.position) || operation.position < 0) {
        return socket.emit("document-error", "Operation position must be a non-negative integer");
      }

      if (operation.type === "insert" && typeof operation.value !== "string") {
        return socket.emit("document-error", "Insert operation requires value");
      }

      if (
        operation.type === "delete" &&
        (!Number.isInteger(operation.length) || operation.length <= 0)
      ) {
        return socket.emit("document-error", "Delete operation requires positive integer length");
      }

      const historyState = getDocumentHistoryState(documentId, doc.version);
      if (operation.version < historyState.baseVersion) {
        return socket.emit("resync-required", {
          documentId,
          content: doc.content,
          version: doc.version,
        });
      }

      let transformedOperation = {
        ...operation,
        userId,
      };

      const startIndex = operation.version - historyState.baseVersion;
      if (startIndex < 0 || startIndex > historyState.operations.length) {
        return socket.emit("resync-required", {
          documentId,
          content: doc.content,
          version: doc.version,
        });
      }

      const missedOperations = historyState.operations.slice(startIndex);
      for (const missedOperation of missedOperations) {
        transformedOperation = transformOperation(missedOperation, transformedOperation);
      }

      if (transformedOperation.type !== "noop") {
        if (transformedOperation.type === "insert") {
          if (transformedOperation.position > doc.content.length) {
            return socket.emit("resync-required", {
              documentId,
              content: doc.content,
              version: doc.version,
            });
          }
        }

        if (
          transformedOperation.type === "delete" &&
          transformedOperation.position + transformedOperation.length > doc.content.length
        ) {
          return socket.emit("resync-required", {
            documentId,
            content: doc.content,
            version: doc.version,
          });
        }
      }

      const nextContent = applyOperationToContent(doc.content, transformedOperation);

      const updatedDoc = await Document.findByIdAndUpdate(
        { _id: documentId, version: doc.version },
        {
          $set: { content: nextContent },
          $inc: { version: 1 },
        },
        { new: true },
      );

      if (!updatedDoc) {
        const latestDoc = await Document.findById(documentId);
        return socket.emit("resync-required", {
          documentId,
          content: latestDoc?.content || "",
          version: latestDoc?.version || doc.version,
        });
      }

      const canonicalOperation = {
        ...transformedOperation,
        documentId,
        userId,
        userName: socket.user?.name || "Unknown user",
        version: updatedDoc.version,
      };

      historyState.operations.push(canonicalOperation);
      while (historyState.operations.length > MAX_OPERATION_HISTORY) {
        historyState.operations.shift();
        historyState.baseVersion += 1;
      }

      io.to(documentId).emit("receive-operation", canonicalOperation);
    } catch (error) {
      console.error("Error applying OT operation:", error);
      socket.emit("document-error", "Failed to apply operation");
    }
  });

  socket.on("leave-document", (documentId) => {
    const userId = socket.user?.id;
    console.log(`User ${userId} wants to leave document ${documentId}`);
    socket.leave(documentId);

    socket.to(documentId).emit("cursor-removed", {
      documentId,
      socketId: socket.id,
    });
  });

  socket.on("disconnect", () => {
    const joinedDocuments = Array.from(socket.rooms).filter(
      (roomId) => roomId !== socket.id,
    );

    joinedDocuments.forEach((documentId) => {
      socket.to(documentId).emit("cursor-removed", {
        documentId,
        socketId: socket.id,
      });
    });

    console.log("A user disconnected: " + socket.id);
  });
});

app.use(
  cors(corsOptions),
);

app.use(bodyParser.json());
app.use(cookieParser());

app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/docs", docsRoutes);

app.get("/", (req, res) => {
  res.send("Server is running!");
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const statusCode = err.statusCode || err.status || 500;
  const message = err.message || "Internal server error";

  return res.status(statusCode).json({
    success: false,
    message,
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
