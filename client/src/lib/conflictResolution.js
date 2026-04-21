/**
 * CLIENT-SIDE CONFLICT RESOLUTION INTEGRATION GUIDE
 * 
 * This module handles the client-side acknowledgment and rebasing
 * for the operational transformation-based conflict resolution.
 */

/**
 * Client Socket Event Handlers for Conflict Resolution
 * 
 * The server now sends back transformation metadata when conflicts occur.
 * The client should:
 * 1. Track pending operations (buffered edits waiting for ACK)
 * 2. Update pending ops when server applies transformations
 * 3. Rebase cursor position if transformations affected earlier text
 * 4. Update UI optimistically, then reconcile on server acknowledgment
 */

export const setupConflictResolutionHandlers = (socket, state) => {
  /**
   * Handle operation acknowledgment with transformation info
   * 
   * event: {
   *   documentId: string,
   *   version: number,
   *   appliedOperations: number,
   *   transformed: boolean (if version mismatch occurred),
   *   transformations: [
   *     {
   *       originalVersion: number,
   *       newVersion: number,
   *       positionChanged: boolean,
   *       newPosition: number
   *     }
   *   ]
   * }
   */
  socket.on("operation-ack", (event) => {
    if (!event || event.documentId !== state.selectedDocId) {
      return;
    }

    const { transformed, transformations } = event;

    if (transformed && transformations) {
      // Server applied transformations to our operations
      // Update our pending ops to reflect the transformations
      console.log("Operations were transformed due to concurrent edits:", transformations);

      // If cursor position was before the transformed operations,
      // we may need to adjust it
      const cursorWasAffected = transformations.some(
        (t) => t.positionChanged && state.cursorPosition > t.newPosition,
      );

      if (cursorWasAffected) {
        // Recalculate cursor position based on transformations
        const totalShift = transformations.reduce((acc, t) => {
          if (t.positionChanged && t.newPosition > state.cursorPosition) {
            return acc + (t.newPosition - state.cursorPosition);
          }
          return acc;
        }, 0);

        // Optional: notify user that their edit was merged with conflicts
        console.log("Your edits were merged with concurrent changes");
      }

      // Update local state to reflect server version
      state.serverVersion = event.version;
    }
  });

  /**
   * Handle operations received from other users
   * May include transformations applied during conflict resolution
   * 
   * event: {
   *   type: 'insert' | 'delete',
   *   position: number,
   *   text?: string (for insert),
   *   length?: number (for delete),
   *   version: number,
   *   transformed: boolean (if this was transformed),
   *   originalVersion: number (if transformed)
   * }
   */
  socket.on("receive-operation", (event) => {
    if (!event) return;

    const { type, position, version, transformed } = event;

    console.log(
      `Received ${transformed ? "transformed " : ""}${type} operation at v${version}`,
    );

    // Apply operation to current content
    if (type === "insert") {
      const { text } = event;
      state.content =
        state.content.slice(0, position) + text + state.content.slice(position);

      // If cursor is at or after insert position, shift it right
      if (state.cursorPosition >= position) {
        state.cursorPosition += text.length;
      }
    } else if (type === "delete") {
      const { length } = event;
      state.content =
        state.content.slice(0, position) + state.content.slice(position + length);

      // If cursor is within deleted range, move to start of deletion
      if (state.cursorPosition >= position && state.cursorPosition < position + length) {
        state.cursorPosition = position;
      }
      // If cursor is after deleted range, shift it left
      else if (state.cursorPosition >= position + length) {
        state.cursorPosition -= length;
      }
    }

    state.serverVersion = version;
  });

  /**
   * Handle resync request (fallback if transformation fails)
   * Server sends full document + version for hard sync
   */
  socket.on("resync-required", (event) => {
    console.warn("Resync required - concurrent edits conflict:", event);

    // Discard local pending operations
    // Full resync will force consistent state
    state.content = event.content;
    state.serverVersion = event.serverVersion;
    state.clientVersion = event.clientVersion;

    // Notify user of the resync
    console.log(
      `Document resynced. Server v${event.serverVersion}, your v${event.clientVersion}`,
    );
  });

  /**
   * Handle operation errors
   */
  socket.on("operation-error", (message) => {
    console.error("Operation error:", message);
    // Trigger resync on error
  });
};

/**
 * CLIENT-SIDE: Send operation to server
 * 
 * Structure operations with version information for conflict detection:
 */
export const sendOperation = (socket, documentId, operation, clientVersion) => {
  socket.emit("send-operation", documentId, {
    ...operation,
    version: clientVersion,
  });
};

/**
 * EXAMPLE: Handling a text edit in React component
 * 
 * When user types:
 * 1. Generate operation (insert/delete)
 * 2. Send to server with current version
 * 3. Apply optimistically to UI
 * 4. Wait for operation-ack
 * 5. If transformed, update pending ops
 */

const handleTextChange = (event, socket, state) => {
  const newContent = event.target.value;
  const cursorPos = event.target.selectionStart || 0;

  // Detect change (insert or delete)
  const oldContent = state.content;

  if (newContent.length > oldContent.length) {
    // Insert
    const insertedText = newContent.slice(
      cursorPos - (newContent.length - oldContent.length),
      cursorPos,
    );
    const insertPosition = cursorPos - insertedText.length;

    const operation = {
      type: "insert",
      position: insertPosition,
      text: insertedText,
    };

    sendOperation(socket, state.documentId, operation, state.serverVersion);

    // Update optimistically
    state.content = newContent;
    state.cursorPosition = cursorPos;
  } else if (newContent.length < oldContent.length) {
    // Delete
    const deletedLength = oldContent.length - newContent.length;
    const deletePosition = cursorPos;

    const operation = {
      type: "delete",
      position: deletePosition,
      length: deletedLength,
    };

    sendOperation(socket, state.documentId, operation, state.serverVersion);

    // Update optimistically
    state.content = newContent;
    state.cursorPosition = cursorPos;
  }
};

/**
 * CONFLICT RESOLUTION SCENARIOS & EXPECTED BEHAVIOR
 * 
 * Scenario 1: Both users append text simultaneously
 * - User A: Insert "X" at position 5 (version 5)
 * - User B: Insert "Y" at position 5 (version 5, sent concurrently)
 * 
 * Server processing:
 * - A processed first: version becomes 6
 * - B arrives at version 6, expected 5 → CONFLICT
 * - B's operation transformed: position stays 5 (same as A)
 * - Both applied successfully, users see "XY" or "YX" (determined by server timestamp)
 * 
 * Scenario 2: One user edits middle, other deletes from start
 * - User A: Insert "!" at position 5 in "Hello World" → "Hello! World"
 * - User B: Delete positions 0-5 (delete "Hello")
 * 
 * Server processing:
 * - A processed: "Hello! World" (version 6)
 * - B arrives, conflicts, gets transformed
 * - B's delete still deletes "Hello", now at same position
 * - Final: "! World" (both edits preserved)
 * 
 * Scenario 3: Multiple rapid edits from same user
 * - User C: [Insert "A" at 0, Insert "B" at 1, Insert "C" at 2]
 * - Batched and sent together with baseVersion
 * - If conflict during flush:
 *   - Entire batch transformed against prior ops
 *   - All positions adjusted correctly
 *   - Maintains relative order
 */

/**
 * CLIENT STATE STRUCTURE
 * 
 * Minimal state needed:
 * {
 *   selectedDocId: string,
 *   content: string,
 *   cursorPosition: number,
 *   serverVersion: number,      // Last ACKed version
 *   clientVersion: number,      // Version we're operating on
 *   pendingOperations: Array,   // Buffered ops waiting for flush
 * }
 */

export default {
  setupConflictResolutionHandlers,
  sendOperation,
  handleTextChange,
};
