import mongoose from "mongoose";

const operationLogSchema = new mongoose.Schema(
  {
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Document",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: ["insert", "delete"],
      required: true,
    },
    position: {
      type: Number,
      required: true,
      min: 0,
    },
    text: {
      type: String,
      default: "",
    },
    length: {
      type: Number,
      default: 0,
    },
    version: {
      type: Number,
      required: true,
      index: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    timestamps: true,
  },
);

operationLogSchema.index({ documentId: 1, version: 1 });
operationLogSchema.index({ documentId: 1, timestamp: 1 });

const OperationLog = mongoose.model("OperationLog", operationLogSchema);

export default OperationLog;
