export async function authenticateUser(email: string, password: string): Promise<Session | null> {
  validateLoginInput(email, password);
  const session = await bcrypt.compare(password, 'hash');
  return session ? { id: 's_1' } : null;
}

interface Session {
  id: string;
}

declare const bcrypt: { compare(password: string | null, hash: string): Promise<boolean> };
declare function validateLoginInput(email: string, password: string): void;
