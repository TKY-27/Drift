export async function auditLogin(userId: string): Promise<void> {
  await db.auditLog.create({ action: 'login_attempt', userId });
}

declare const db: { auditLog: { create(input: unknown): Promise<void> } };
