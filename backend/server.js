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

      const isOwner = doc.owner.toString() === userId;
      const isCollaborator = doc.collaborators.some(
        (collaboratorId) => collaboratorId.toString() === userId,
      );

      if (!isOwner && !isCollaborator) {
        return socket.emit(
          "document-error",
          "Access denied: you are not a collaborator on this document",
        );
      }

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

  socket.on("document-content-change", async (payload) => {
    const userId = socket.user?.id;

    try {
      const { documentId, content } = payload || {};

      if (!documentId || typeof content !== "string") {
        return socket.emit("document-error", "Invalid realtime update payload");
      }

      const doc = await Document.findById(documentId);
      if (!doc) {
        return socket.emit("document-error", "Document not found");
      }

      const isOwner = doc.owner.toString() === userId;
      const isCollaborator = doc.collaborators.some(
        (collaboratorId) => collaboratorId.toString() === userId,
      );

      if (!isOwner && !isCollaborator) {
        return socket.emit("document-error", "Access denied");
      }

      const updatedDoc = await Document.findByIdAndUpdate(
        documentId,
        {
          $set: { content },
          $inc: { version: 1 },
        },
        { new: true },
      );

      socket.to(documentId).emit("document-content-updated", {
        documentId,
        content: updatedDoc?.content || content,
        version: updatedDoc?.version || doc.version + 1,
        senderSocketId: socket.id,
        editedBy: {
          userId: socket.user?.id,
          userName: socket.user?.name || "Unknown user",
        },
      });
    } catch (error) {
      console.error("Error applying realtime update:", error);
      socket.emit("document-error", "Failed to apply realtime update");
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
