export class RuntimeError extends Error { constructor(status, message) { super(message); this.status = status; } }
