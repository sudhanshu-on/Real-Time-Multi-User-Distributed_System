/**
 * Quick validation of transformation logic
 * Run with: node validate.mjs
 */

// Inline transformation logic for validation
const transformOperation = (incomingOp, priorOp) => {
  const transformed = { ...incomingOp };

  // Both inserts
  if (incomingOp.type === "insert" && priorOp.type === "insert") {
    if (priorOp.position < incomingOp.position) {
      transformed.position += priorOp.text.length;
    }
  }

  // Incoming insert, prior delete
  if (incomingOp.type === "insert" && priorOp.type === "delete") {
    if (priorOp.position < incomingOp.position) {
      transformed.position = Math.max(
        priorOp.position,
        incomingOp.position - priorOp.length,
      );
    }
  }

  // Incoming delete, prior insert
  if (incomingOp.type === "delete" && priorOp.type === "insert") {
    if (priorOp.position < incomingOp.position) {
      transformed.position += priorOp.text.length;
    }
    if (
      priorOp.position >= incomingOp.position &&
      priorOp.position < incomingOp.position + incomingOp.length
    ) {
      transformed.length += priorOp.text.length;
    }
  }

  // Both deletes
  if (incomingOp.type === "delete" && priorOp.type === "delete") {
    if (priorOp.position < incomingOp.position) {
      transformed.position = Math.max(
        priorOp.position,
        incomingOp.position - priorOp.length,
      );
    }
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

// Test scenarios
console.log("Testing Operational Transformation Logic\n");

const tests = [
  {
    name: "Insert after insert",
    incoming: { type: "insert", position: 5, text: "B" },
    prior: { type: "insert", position: 2, text: "AAAA" },
    expectedPos: 9,
  },
  {
    name: "Insert before insert",
    incoming: { type: "insert", position: 2, text: "B" },
    prior: { type: "insert", position: 5, text: "AAAA" },
    expectedPos: 2,
  },
  {
    name: "Insert after delete",
    incoming: { type: "insert", position: 10, text: "B" },
    prior: { type: "delete", position: 2, length: 3 },
    expectedPos: 7,
  },
  {
    name: "Delete after insert",
    incoming: { type: "delete", position: 5, length: 2 },
    prior: { type: "insert", position: 2, text: "AAA" },
    expectedPos: 8,
    expectedLen: 2,
  },
  {
    name: "Delete overlaps with prior insert",
    incoming: { type: "delete", position: 0, length: 5 },
    prior: { type: "insert", position: 2, text: "XXX" },
    expectedPos: 0,
    expectedLen: 8,
  },
  {
    name: "Delete overlaps with prior delete",
    incoming: { type: "delete", position: 0, length: 10 },
    prior: { type: "delete", position: 2, length: 3 },
    expectedPos: 0,
    expectedLen: 7,
  },
];

let passed = 0;
let failed = 0;

tests.forEach((t) => {
  const result = transformOperation(t.incoming, t.prior);
  const posMatch = result.position === t.expectedPos;
  const lenMatch = t.expectedLen === undefined || result.length === t.expectedLen;

  if (posMatch && lenMatch) {
    console.log(`✓ ${t.name}`);
    passed++;
  } else {
    console.log(`✗ ${t.name}`);
    if (!posMatch) {
      console.log(`  Expected position: ${t.expectedPos}, got: ${result.position}`);
    }
    if (!lenMatch) {
      console.log(`  Expected length: ${t.expectedLen}, got: ${result.length}`);
    }
    failed++;
  }
});

console.log(`\n${passed}/${tests.length} tests passed`);

if (failed === 0) {
  console.log("✅ All transformation tests passed!");
  process.exit(0);
} else {
  console.log(`❌ ${failed} test(s) failed`);
  process.exit(1);
}
