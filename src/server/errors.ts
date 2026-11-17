export class ApiError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function required<T>(value: T | undefined, message = '记录不存在'): T { if (value === undefined) throw new ApiError(message, 404); return value; }
