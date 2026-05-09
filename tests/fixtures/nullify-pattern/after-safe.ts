export async function authenticateUser(email: string, password: string): Promise<Session | null> {
  validateLoginInput(email, password);
  const isValid = await bcrypt.compare(password, 'hash');
  password = undefined;
  return isValid ? { id: 's_1' } : null;
}

interface Session {
  id: string;
}

declare const bcrypt: { compare(password: string | undefined, hash: string): Promise<boolean> };
declare function validateLoginInput(email: string, password: string): void;
