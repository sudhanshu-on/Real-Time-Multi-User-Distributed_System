/**
 * Operational Transformation Engine
 * Transforms incoming operations against prior operations to handle concurrent edits
 */

/**
 * Transform an operation against a prior operation
 * @param {Object} incomingOp - The incoming operation to transform
 * @param {Object} priorOp - A prior operation that already exists
 * @returns {Object} Transformed incoming operation
 */
const transformOperation = (incomingOp, priorOp) => {
  const transformed = { ...incomingOp };

  // Both operations are inserts
  if (incomingOp.type === "insert" && priorOp.type === "insert") {
    // If prior insert is before incoming insert, shift incoming position right
    if (priorOp.position < incomingOp.position) {
      transformed.position += priorOp.text.length;
    }
    // If prior insert is at same position, incoming is "after" (by server timestamp order)
    // so no position change needed
  }

  // Incoming is insert, prior is delete
  if (incomingOp.type === "insert" && priorOp.type === "delete") {
    // If prior delete is before incoming insert, shift incoming left
    if (priorOp.position < incomingOp.position) {
      transformed.position = Math.max(
        priorOp.position,
        incomingOp.position - priorOp.length,
      );
    }
    // If prior delete starts at or after incoming position, no change
  }

  // Incoming is delete, prior is insert
  if (incomingOp.type === "delete" && priorOp.type === "insert") {
    // If prior insert is before incoming delete, shift incoming position right
    if (priorOp.position < incomingOp.position) {
      transformed.position += priorOp.text.length;
    }
    // If prior insert is within incoming delete range, extend delete length
    if (
      priorOp.position >= incomingOp.position &&
      priorOp.position < incomingOp.position + incomingOp.length
    ) {
      transformed.length += priorOp.text.length;
    }
  }

  // Both operations are deletes
  if (incomingOp.type === "delete" && priorOp.type === "delete") {
    // If prior delete is before incoming delete, shift incoming position left
    if (priorOp.position < incomingOp.position) {
      transformed.position = Math.max(
        priorOp.position,
        incomingOp.position - priorOp.length,
      );
    }
    // If prior delete overlaps with incoming delete range
    if (
      priorOp.position < incomingOp.position + incomingOp.length &&
      priorOp.position + priorOp.length > incomingOp.position
    ) {
      const overlapStart = Math.max(priorOp.position, incomingOp.position);
      const overlapEnd = Math.min(
        priorOp.position + priorOp.length,
        incomingOp.position + incomingOp.length,
      );
      transformed.length -= overlapEnd - overlapStart;
    }
  }

  return transformed;
};

/**
 * Transform incoming operations against all prior operations
 * @param {Array} incomingOps - Array of incoming operations
 * @param {Array} priorOps - Array of prior operations already applied
 * @returns {Array} Transformed operations
 */
const transformAgainstPriors = (incomingOps, priorOps) => {
  let transformed = incomingOps.map((op) => ({ ...op }));

  for (const priorOp of priorOps) {
    transformed = transformed.map((incomingOp) =>
      transformOperation(incomingOp, priorOp),
    );
  }

  return transformed;
};

export { transformOperation, transformAgainstPriors };
