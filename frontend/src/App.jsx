import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  API_BASE_URL,
  addCollaborator,
  createDoc,
  deleteDoc,
  getCurrentUser,
  getDocs,
  logout,
  signin,
  signup,
} from "./lib/apiClient";
import "./App.css";

const initialAuthForm = {
  name: "",
  email: "",
  password: "",
};

const initialDocForm = {
  name: "",
  description: "",
  content: "",
};

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

    if (op1.position === out.position && compareOpOrder(op1, out) <= 0) {
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
      return {
        ...out,
        type: "noop",
      };
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

const deriveOperationsFromContentChange = ({ previousContent, nextContent, userId, createOpId }) => {
  if (previousContent === nextContent) {
    return [];
  }

  let start = 0;
  while (
    start < previousContent.length &&
    start < nextContent.length &&
    previousContent[start] === nextContent[start]
  ) {
    start += 1;
  }

  let prevEnd = previousContent.length - 1;
  let nextEnd = nextContent.length - 1;
  while (
    prevEnd >= start &&
    nextEnd >= start &&
    previousContent[prevEnd] === nextContent[nextEnd]
  ) {
    prevEnd -= 1;
    nextEnd -= 1;
  }

  const deletedText = previousContent.slice(start, prevEnd + 1);
  const insertedText = nextContent.slice(start, nextEnd + 1);
  const operations = [];

  if (deletedText.length > 0) {
    operations.push({
      opId: createOpId(),
      userId,
      type: "delete",
      position: start,
      length: deletedText.length,
    });
  }

  if (insertedText.length > 0) {
    operations.push({
      opId: createOpId(),
      userId,
      type: "insert",
      position: start,
      value: insertedText,
    });
  }

  return operations;
};

function App() {
  const appName = import.meta.env.VITE_APP_NAME || "Collab Docs";
  const [mode, setMode] = useState("signin");
  const [authForm, setAuthForm] = useState(initialAuthForm);
  const [docForm, setDocForm] = useState(initialDocForm);
  const [docs, setDocs] = useState([]);
  const [selectedDocId, setSelectedDocId] = useState("");
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [collaboratorEmail, setCollaboratorEmail] = useState("");
  const [collaboratorFeedback, setCollaboratorFeedback] = useState({
    type: "",
    message: "",
  });
  const [showCollaborators, setShowCollaborators] = useState(false);
  const [activeEditors, setActiveEditors] = useState([]);
  const [lastEditedBy, setLastEditedBy] = useState("");
  const socketRef = useRef(null);
  const cursorEmitTimerRef = useRef(null);
  const pendingOperationsRef = useRef([]);
  const receivedOperationBufferRef = useRef(new Map());
  const knownVersionRef = useRef(0);
  const localOperationCounterRef = useRef(0);
  const selectedDocIdRef = useRef("");
  const docsRef = useRef([]);
  const userRef = useRef(null);
  const contentTextareaRef = useRef(null);
  const [remoteCursors, setRemoteCursors] = useState([]);

  const selectedDoc = useMemo(
    () => docs.find((doc) => doc._id === selectedDocId) || null,
    [docs, selectedDocId],
  );

  const selectedDocCollaborators = useMemo(
    () => (Array.isArray(selectedDoc?.collaborators) ? selectedDoc.collaborators : []),
    [selectedDoc],
  );

  useEffect(() => {
    if (!collaboratorFeedback.message) {
      return;
    }

    const timerId = window.setTimeout(() => {
      setCollaboratorFeedback({ type: "", message: "" });
    }, 4000);

    return () => {
      window.clearTimeout(timerId);
    };
  }, [collaboratorFeedback.message]);

  useEffect(() => {
    selectedDocIdRef.current = selectedDocId;
  }, [selectedDocId]);

  useEffect(() => {
    docsRef.current = docs;
  }, [docs]);

  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const getCursorCoordinates = (textarea, position) => {
    if (!textarea) {
      return null;
    }

    const style = window.getComputedStyle(textarea);
    const mirror = document.createElement("div");
    const marker = document.createElement("span");

    mirror.style.position = "absolute";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.style.whiteSpace = "pre-wrap";
    mirror.style.wordWrap = "break-word";
    mirror.style.overflowWrap = "break-word";
    mirror.style.boxSizing = "border-box";

    mirror.style.fontFamily = style.fontFamily;
    mirror.style.fontSize = style.fontSize;
    mirror.style.fontWeight = style.fontWeight;
    mirror.style.lineHeight = style.lineHeight;
    mirror.style.letterSpacing = style.letterSpacing;
    mirror.style.padding = style.padding;
    mirror.style.border = style.border;
    mirror.style.width = `${textarea.clientWidth}px`;

    const safePosition = Math.max(0, Math.min(position, textarea.value.length));
    const textBefore = textarea.value.slice(0, safePosition);

    mirror.textContent = textBefore;
    marker.textContent = "\u200b";
    mirror.appendChild(marker);
    document.body.appendChild(mirror);

    const left = marker.offsetLeft - textarea.scrollLeft;
    const top = marker.offsetTop - textarea.scrollTop;

    document.body.removeChild(mirror);

    if (left < 0 || top < 0 || left > textarea.clientWidth || top > textarea.clientHeight) {
      return null;
    }

    return { left, top };
  };

  const resolveEditorName = (userId, fallbackName) => {
    if (fallbackName && fallbackName !== "Unknown user") {
      return fallbackName;
    }

    const activeDoc = docsRef.current.find(
      (doc) => doc._id === selectedDocIdRef.current,
    );

    if (userId && activeDoc?.owner?._id === userId) {
      return activeDoc.owner?.name || activeDoc.owner?.email || "Unknown user";
    }

    if (userId && Array.isArray(activeDoc?.collaborators)) {
      const matchedCollaborator = activeDoc.collaborators.find(
        (collaborator) => collaborator?._id === userId,
      );

      if (matchedCollaborator) {
        return (
          matchedCollaborator.name || matchedCollaborator.email || "Unknown user"
        );
      }
    }

    if (userId && userRef.current?._id === userId) {
      return userRef.current.name || userRef.current.email || "Unknown user";
    }

    return fallbackName || "Unknown user";
  };

  const createLocalOpId = () => {
    localOperationCounterRef.current += 1;
    return `${userRef.current?._id || "anonymous"}:${Date.now()}:${localOperationCounterRef.current}`;
  };

  const trySendNextPendingOperation = () => {
    if (!socketRef.current || !selectedDocIdRef.current) {
      return;
    }

    const queue = pendingOperationsRef.current;
    if (!queue.length || queue[0].sent) {
      return;
    }

    const operationToSend = {
      ...queue[0],
      version: knownVersionRef.current,
    };

    queue[0] = {
      ...operationToSend,
      sent: true,
    };

    socketRef.current.emit("send-operation", {
      documentId: selectedDocIdRef.current,
      operation: operationToSend,
    });
  };

  const updateDocStateWithOperation = (operation) => {
    setDocs((previous) =>
      previous.map((doc) => {
        if (doc._id !== operation.documentId) {
          return doc;
        }

        return {
          ...doc,
          content: applyOperationToContent(doc.content || "", operation),
          version: operation.version,
        };
      }),
    );

    if (operation.documentId === selectedDocIdRef.current) {
      setDocForm((previous) => ({
        ...previous,
        content: applyOperationToContent(previous.content || "", operation),
      }));
    }
  };

  const processServerOperations = () => {
    const buffer = receivedOperationBufferRef.current;

    while (buffer.has(knownVersionRef.current + 1)) {
      const operation = buffer.get(knownVersionRef.current + 1);
      buffer.delete(knownVersionRef.current + 1);

      const queue = pendingOperationsRef.current;
      const pendingIndex = queue.findIndex((queued) => queued.opId === operation.opId);

      if (pendingIndex === 0) {
        queue.shift();
      } else if (pendingIndex !== -1) {
        queue.splice(pendingIndex, 1);
      } else {
        updateDocStateWithOperation(operation);

        pendingOperationsRef.current = pendingOperationsRef.current
          .map((queuedOperation) => {
            const transformed = transformOperation(operation, queuedOperation);
            return {
              ...transformed,
              sent: queuedOperation.sent,
            };
          })
          .filter((queuedOperation) => queuedOperation.type !== "noop");

        if (operation.documentId === selectedDocIdRef.current && operation.userId !== userRef.current?._id) {
          setLastEditedBy(resolveEditorName(operation.userId, operation.userName));
        }
      }

      knownVersionRef.current = operation.version;

      setDocs((previous) =>
        previous.map((doc) =>
          doc._id === operation.documentId
            ? {
                ...doc,
                version: operation.version,
              }
            : doc,
        ),
      );

      trySendNextPendingOperation();
    }
  };

  const emitCursorUpdate = (position, immediate = false) => {
    if (!socketRef.current || !selectedDocIdRef.current) {
      return;
    }

    const safePosition = Number.isInteger(position) && position >= 0 ? position : 0;

    if (cursorEmitTimerRef.current) {
      window.clearTimeout(cursorEmitTimerRef.current);
    }

    if (immediate) {
      socketRef.current.emit("cursor-update", {
        documentId: selectedDocIdRef.current,
        position: safePosition,
      });
      return;
    }

    cursorEmitTimerRef.current = window.setTimeout(() => {
      socketRef.current?.emit("cursor-update", {
        documentId: selectedDocIdRef.current,
        position: safePosition,
      });
    }, 45);
  };

  const handleCursorMovement = (event) => {
    if (!selectedDoc) {
      return;
    }

    const caretPosition = event.target.selectionStart || 0;
    emitCursorUpdate(caretPosition);
  };

  useEffect(() => {
    if (!user) {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
      return;
    }

    const socket = io(API_BASE_URL, {
      withCredentials: true,
      transports: ["websocket", "polling"],
    });

    socketRef.current = socket;

    const joinActiveDocument = () => {
      const activeDocumentId = selectedDocIdRef.current;
      if (activeDocumentId) {
        socket.emit("join-document", activeDocumentId);
      }
    };

    socket.on("connect", () => {
      joinActiveDocument();
    });

    socket.on("document-error", (message) => {
      setError(message || "Realtime error");
    });

    socket.on("load-document", (payload) => {
      if (!payload || payload.documentId !== selectedDocIdRef.current) {
        return;
      }

      pendingOperationsRef.current = [];
      receivedOperationBufferRef.current = new Map();
      knownVersionRef.current = payload.version ?? 0;

      setDocForm({
        name: payload.name || "",
        description: payload.description || "",
        content: payload.content || "",
      });

      setDocs((previous) =>
        previous.map((doc) =>
          doc._id === payload.documentId
            ? {
                ...doc,
                name: payload.name ?? doc.name,
                description: payload.description ?? doc.description,
                content: payload.content ?? doc.content,
                version: payload.version ?? doc.version,
              }
            : doc,
        ),
      );
    });

    socket.on("receive-operation", (payload) => {
      if (!payload || typeof payload.version !== "number") {
        return;
      }

      if (payload.version <= knownVersionRef.current) {
        return;
      }

      receivedOperationBufferRef.current.set(payload.version, payload);
      processServerOperations();
    });

    socket.on("resync-required", (payload) => {
      if (!payload || payload.documentId !== selectedDocIdRef.current) {
        return;
      }

      pendingOperationsRef.current = [];
      receivedOperationBufferRef.current = new Map();
      knownVersionRef.current = payload.version ?? 0;

      setDocForm((previous) => ({
        ...previous,
        content: payload.content || "",
      }));

      setDocs((previous) =>
        previous.map((doc) =>
          doc._id === selectedDocIdRef.current
            ? {
                ...doc,
                content: payload.content || "",
                version: payload.version ?? doc.version,
              }
            : doc,
        ),
      );
    });

    socket.on("presence-sync", (payload) => {
      if (!payload || payload.documentId !== selectedDocIdRef.current) {
        return;
      }

      setActiveEditors(
        Array.isArray(payload.participants)
          ? payload.participants.map((participant) => ({
              ...participant,
              userName: resolveEditorName(participant.userId, participant.userName),
              lastSeen: Date.now(),
            }))
          : [],
      );
    });

    socket.on("cursor-update", (payload) => {
      if (!payload || payload.documentId !== selectedDocIdRef.current) {
        return;
      }

      if (payload.socketId === socket.id) {
        return;
      }

      setActiveEditors((previous) => {
        const rest = previous.filter((editor) => editor.socketId !== payload.socketId);
        return [
          ...rest,
          {
            socketId: payload.socketId,
            userId: payload.userId,
            userName: resolveEditorName(payload.userId, payload.userName),
            position: payload.position,
            lastSeen: Date.now(),
          },
        ];
      });
    });

    socket.on("cursor-removed", (payload) => {
      if (!payload || payload.documentId !== selectedDocIdRef.current) {
        return;
      }

      setActiveEditors((previous) =>
        previous.filter((editor) => editor.socketId !== payload.socketId),
      );
    });

    return () => {
      if (cursorEmitTimerRef.current) {
        window.clearTimeout(cursorEmitTimerRef.current);
      }
      pendingOperationsRef.current = [];
      receivedOperationBufferRef.current = new Map();
      knownVersionRef.current = 0;
      socket.disconnect();
      socketRef.current = null;
      setActiveEditors([]);
    };
  }, [user]);

  useEffect(() => {
    const cleanupInterval = window.setInterval(() => {
      const cutoff = Date.now() - 3500;
      setActiveEditors((previous) =>
        previous.filter((editor) => (editor.lastSeen || 0) >= cutoff),
      );
    }, 1200);

    return () => {
      window.clearInterval(cleanupInterval);
    };
  }, []);

  useEffect(() => {
    const textarea = contentTextareaRef.current;
    if (!textarea || !selectedDocId) {
      setRemoteCursors([]);
      return;
    }

    const nextRemoteCursors = activeEditors
      .map((editor) => {
        const coords = getCursorCoordinates(textarea, editor.position || 0);
        if (!coords) {
          return null;
        }

        return {
          socketId: editor.socketId,
          userName: editor.userName,
          left: coords.left,
          top: coords.top,
        };
      })
      .filter(Boolean);

    setRemoteCursors(nextRemoteCursors);
  }, [activeEditors, docForm.content, selectedDocId]);

  useEffect(() => {
    if (!lastEditedBy) {
      return;
    }

    const clearTimerId = window.setTimeout(() => {
      setLastEditedBy("");
    }, 2600);

    return () => {
      window.clearTimeout(clearTimerId);
    };
  }, [lastEditedBy]);

  useEffect(() => {
    if (!selectedDocId || !socketRef.current) {
      return;
    }

    socketRef.current.emit("join-document", selectedDocId);

    return () => {
      socketRef.current?.emit("leave-document", selectedDocId);
    };
  }, [selectedDocId]);

  useEffect(() => {
    const checkSession = async () => {
      try {
        const [currentUser, docsFromApi] = await Promise.all([
          getCurrentUser(),
          getDocs(),
        ]);

        setUser(currentUser);
        setDocs(docsFromApi);
        if (docsFromApi.length > 0) {
          setSelectedDocId(docsFromApi[0]._id);
        }
      } catch {
        setUser(null);
      }
    };

    checkSession();
  }, []);

  const resetFeedback = () => {
    setError("");
    setNotice("");
  };

  const handleAuthFormChange = (event) => {
    const { name, value } = event.target;
    setAuthForm((previous) => ({
      ...previous,
      [name]: value,
    }));
  };

  const handleDocFormChange = (event) => {
    const { name, value } = event.target;
    setDocForm((previous) => ({
      ...previous,
      [name]: value,
    }));
  };

  const loadDocs = async () => {
    const docsFromApi = await getDocs();
    setDocs(docsFromApi);
    if (docsFromApi.length > 0) {
      setSelectedDocId((previous) => previous || docsFromApi[0]._id);
    } else {
      setSelectedDocId("");
    }
  };

  const handleAuthSubmit = async (event) => {
    event.preventDefault();
    resetFeedback();
    setLoading(true);

    try {
      if (mode === "signup") {
        await signup({
          name: authForm.name,
          email: authForm.email,
          password: authForm.password,
        });
        setNotice("Account created. Please sign in.");
        setMode("signin");
        setAuthForm((previous) => ({ ...previous, password: "" }));
      } else {
        const response = await signin({
          email: authForm.email,
          password: authForm.password,
        });
        setUser(response?.user || { name: "Authenticated User" });
        setAuthForm(initialAuthForm);
        await loadDocs();
        setNotice("Signed in successfully.");
      }
    } catch (err) {
      setError(err.message || "Authentication failed");
    } finally {
      setLoading(false);
    }
  };

  const handleCreateDoc = async (event) => {
    event.preventDefault();
    resetFeedback();
    setLoading(true);

    try {
      const created = await createDoc(docForm);
      const updatedDocs = [created, ...docs];
      setDocs(updatedDocs);
      setSelectedDocId(created._id);
      pendingOperationsRef.current = [];
      receivedOperationBufferRef.current = new Map();
      knownVersionRef.current = created.version ?? 0;
      setDocForm(initialDocForm);
      setNotice("Document created.");
    } catch (err) {
      setError(err.message || "Unable to create document");
    } finally {
      setLoading(false);
    }
  };

  const handleSelectDoc = (doc) => {
    setSelectedDocId(doc._id);
    pendingOperationsRef.current = [];
    receivedOperationBufferRef.current = new Map();
    knownVersionRef.current = doc.version ?? 0;
    setShowCollaborators(false);
    setCollaboratorEmail("");
    setCollaboratorFeedback({ type: "", message: "" });
    setDocForm({
      name: doc.name,
      description: doc.description || "",
      content: doc.content || "",
    });
    resetFeedback();
  };

  const handleRealtimeContentChange = (event) => {
    const previousContent = docForm.content || "";
    const nextContent = event.target.value;
    const caretPosition = event.target.selectionStart || 0;

    setDocForm((previous) => ({
      ...previous,
      content: nextContent,
    }));

    if (!selectedDoc) {
      return;
    }

    setDocs((previous) =>
      previous.map((doc) =>
        doc._id === selectedDoc._id
          ? {
              ...doc,
              content: nextContent,
            }
          : doc,
      ),
    );

    const derivedOperations = deriveOperationsFromContentChange({
      previousContent,
      nextContent,
      userId: userRef.current?._id,
      createOpId: createLocalOpId,
    });

    if (derivedOperations.length) {
      pendingOperationsRef.current.push(
        ...derivedOperations.map((operation) => ({
          ...operation,
          sent: false,
        })),
      );

      trySendNextPendingOperation();
    }

    emitCursorUpdate(caretPosition, true);
  };

  const handleDeleteDoc = async () => {
    if (!selectedDoc) {
      setError("Select a document before deleting.");
      return;
    }

    resetFeedback();
    setLoading(true);

    try {
      await deleteDoc(selectedDoc._id);
      const remaining = docs.filter((doc) => doc._id !== selectedDoc._id);
      setDocs(remaining);
      setSelectedDocId(remaining[0]?._id || "");
      setDocForm(
        remaining[0]
          ? {
              name: remaining[0].name,
              description: remaining[0].description || "",
              content: remaining[0].content || "",
            }
          : initialDocForm,
      );
      setNotice("Document deleted.");
    } catch (err) {
      setError(err.message || "Unable to delete document");
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    resetFeedback();
    setLoading(true);
    try {
      await logout();
      setUser(null);
      setDocs([]);
      setSelectedDocId("");
      setDocForm(initialDocForm);
      setActiveEditors([]);
      setLastEditedBy("");
      setNotice("Logged out.");
    } catch (err) {
      setError(err.message || "Unable to logout");
    } finally {
      setLoading(false);
    }
  };

  const handleAddCollaborator = async (event) => {
    event.preventDefault();
    setCollaboratorFeedback({ type: "", message: "" });

    if (!selectedDoc) {
      setCollaboratorFeedback({
        type: "error",
        message: "Select a document before adding collaborators.",
      });
      return;
    }

    const email = collaboratorEmail.trim();
    if (!email) {
      setCollaboratorFeedback({
        type: "error",
        message: "Collaborator email is required.",
      });
      return;
    }

    resetFeedback();
    setLoading(true);

    try {
      const updated = await addCollaborator(selectedDoc._id, { collaboratorEmail: email });
      setDocs((previous) =>
        previous.map((doc) => (doc._id === updated._id ? updated : doc)),
      );
      setCollaboratorEmail("");
      setCollaboratorFeedback({
        type: "notice",
        message: "Collaborator added successfully.",
      });
      setNotice("Collaborator added successfully.");
    } catch (err) {
      const rawMessage = err?.message || "Unable to add collaborator";
      const normalizedMessage = rawMessage.toLowerCase();

      if (normalizedMessage.includes("already") && normalizedMessage.includes("collaborator")) {
        setCollaboratorFeedback({
          type: "error",
          message: "This user is already a collaborator for the selected document.",
        });
      } else if (normalizedMessage.includes("not found")) {
        setCollaboratorFeedback({
          type: "error",
          message: "No user found with that email address.",
        });
      } else {
        setCollaboratorFeedback({ type: "error", message: rawMessage });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!selectedDocId) {
      return;
    }

    const activeDoc = docs.find((doc) => doc._id === selectedDocId);
    if (!activeDoc) {
      return;
    }

    setDocForm({
      name: activeDoc.name,
      description: activeDoc.description || "",
      content: activeDoc.content || "",
    });

    pendingOperationsRef.current = [];
    receivedOperationBufferRef.current = new Map();
    knownVersionRef.current = activeDoc.version ?? 0;

    setActiveEditors([]);
    setLastEditedBy("");
  }, [selectedDocId]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="badge">Realtime workspace</p>
          <h1>{appName}</h1>
          <p className="subtitle">Connected to the Server</p>
        </div>
        {user ? (
          <div className="user-block">
            <p>{user.name || user.email || "Authenticated user"}</p>
            <button type="button" onClick={handleLogout} disabled={loading}>
              Logout
            </button>
          </div>
        ) : null}
      </header>

      {error ? <p className="feedback error">{error}</p> : null}
      {notice ? <p className="feedback notice">{notice}</p> : null}

      {!user ? (
        <section className="auth-card">
          <div className="tabs" role="tablist" aria-label="auth mode">
            <button
              type="button"
              className={mode === "signin" ? "active" : ""}
              onClick={() => setMode("signin")}
            >
              Sign in
            </button>
            <button
              type="button"
              className={mode === "signup" ? "active" : ""}
              onClick={() => setMode("signup")}
            >
              Sign up
            </button>
          </div>

          <form onSubmit={handleAuthSubmit} className="auth-form">
            {mode === "signup" ? (
              <label>
                Name
                <input
                  name="name"
                  type="text"
                  value={authForm.name}
                  onChange={handleAuthFormChange}
                  required
                  minLength={2}
                />
              </label>
            ) : null}

            <label>
              Email
              <input
                name="email"
                type="email"
                value={authForm.email}
                onChange={handleAuthFormChange}
                required
              />
            </label>

            <label>
              Password
              <input
                name="password"
                type="password"
                value={authForm.password}
                onChange={handleAuthFormChange}
                required
                minLength={6}
              />
            </label>

            <button type="submit" disabled={loading}>
              {loading
                ? "Please wait..."
                : mode === "signin"
                  ? "Sign in"
                  : "Create account"}
            </button>
          </form>
        </section>
      ) : (
        <section className="workspace-grid">
          <aside className="docs-panel">
            <h2>Documents</h2>
            <form onSubmit={handleCreateDoc} className="create-form">
              <input
                name="name"
                placeholder="Document title"
                value={docForm.name}
                onChange={handleDocFormChange}
                required
              />
              <textarea
                name="description"
                placeholder="Short description"
                value={docForm.description}
                onChange={handleDocFormChange}
                rows={2}
              />
              <button type="submit" disabled={loading}>
                New document
              </button>
            </form>

            <div className="doc-list">
              {docs.length === 0 ? (
                <p className="empty">No documents yet.</p>
              ) : (
                docs.map((doc) => (
                  <button
                    key={doc._id}
                    type="button"
                    className={doc._id === selectedDocId ? "doc-item active" : "doc-item"}
                    onClick={() => handleSelectDoc(doc)}
                  >
                    <strong>{doc.name}</strong>
                    <span>{doc.description || "No description"}</span>
                  </button>
                ))
              )}
            </div>
          </aside>

          <main className="editor-panel">
            <div className="editor-heading">
              <h2>Editor</h2>
              <button type="button" className="danger" onClick={handleDeleteDoc}>
                Delete
              </button>
            </div>

            <section className="collaborator-panel">
              <h3>Add collaborator</h3>
              <form onSubmit={handleAddCollaborator} className="collaborator-form">
                <input
                  type="email"
                  value={collaboratorEmail}
                  onChange={(event) => setCollaboratorEmail(event.target.value)}
                  placeholder="teammate@email.com"
                  disabled={!selectedDoc}
                  required
                />
                <button
                  type="submit"
                  disabled={loading || !selectedDoc || !collaboratorEmail.trim()}
                >
                  Add
                </button>
              </form>
              <p className="collaborator-meta">
                {selectedDoc
                  ? `Collaborators: ${selectedDoc.collaborators?.length || 0}`
                  : "Select a document to manage collaborators."}
              </p>
              <button
                type="button"
                className="collaborator-toggle"
                onClick={() => setShowCollaborators((previous) => !previous)}
                disabled={!selectedDoc}
              >
                {showCollaborators ? "Hide collaborators" : "Show collaborators"}
              </button>
              {selectedDoc && showCollaborators ? (
                <>
                  <p className="collaborator-meta owner-meta">
                    Owner: {selectedDoc.owner?.name || "Unknown owner"}
                  </p>
                  <div className="collaborator-list" aria-live="polite">
                    {selectedDocCollaborators.length === 0 ? (
                      <p className="collaborator-empty">No collaborators added yet.</p>
                    ) : (
                      selectedDocCollaborators.map((collaborator) => (
                        <div
                          key={collaborator._id || collaborator.email || collaborator}
                          className="collaborator-chip"
                        >
                          <strong>{collaborator.name || collaborator.email || "Unknown"}</strong>
                          <span>{collaborator.email || "No email"}</span>
                        </div>
                      ))
                    )}
                  </div>
                </>
              ) : null}
              {collaboratorFeedback.message ? (
                <p className={`collaborator-feedback ${collaboratorFeedback.type}`}>
                  {collaboratorFeedback.message}
                </p>
              ) : null}
            </section>

            <form className="editor-form">
              <label>
                Title
                <input
                  name="name"
                  value={docForm.name}
                  placeholder="Select or create a document"
                  required
                  disabled
                />
              </label>

              <label>
                Description
                <textarea
                  name="description"
                  value={docForm.description}
                  rows={2}
                  disabled
                />
              </label>

              <label>
                Content
                <div className="editor-textarea-wrap">
                  <textarea
                    ref={contentTextareaRef}
                    name="content"
                    value={docForm.content}
                    onChange={handleRealtimeContentChange}
                    onClick={handleCursorMovement}
                    onMouseUp={handleCursorMovement}
                    onKeyUp={handleCursorMovement}
                    onSelect={handleCursorMovement}
                    onFocus={handleCursorMovement}
                    onScroll={() => {
                      const textarea = contentTextareaRef.current;
                      if (!textarea) {
                        return;
                      }

                      const nextRemoteCursors = activeEditors
                        .map((editor) => {
                          const coords = getCursorCoordinates(textarea, editor.position || 0);
                          if (!coords) {
                            return null;
                          }

                          return {
                            socketId: editor.socketId,
                            userName: editor.userName,
                            left: coords.left,
                            top: coords.top,
                          };
                        })
                        .filter(Boolean);

                      setRemoteCursors(nextRemoteCursors);
                    }}
                    rows={14}
                    disabled={!selectedDoc}
                  />
                  <div className="remote-cursor-layer" aria-hidden="true">
                    {remoteCursors.map((cursor) => (
                      <div
                        key={cursor.socketId}
                        className="remote-cursor"
                        style={{ left: cursor.left, top: cursor.top }}
                      >
                        <span className="remote-cursor-caret" />
                        <span className="remote-cursor-label">{cursor.userName}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </label>
              <p className="collaborator-meta">Live sync is active for content updates.</p>
              {lastEditedBy ? (
                <p className="collaborator-meta" aria-live="polite">
                  Currently edited by: {lastEditedBy}
                </p>
              ) : null}
              {activeEditors.length > 0 ? (
                <div className="active-editors" aria-live="polite">
                  {activeEditors.map((editor) => (
                    <span key={editor.socketId} className="editor-pill">
                      {editor.userName} editing
                    </span>
                  ))}
                </div>
              ) : null}
            </form>
          </main>
        </section>
      )}
    </div>
  );
}

export default App;
