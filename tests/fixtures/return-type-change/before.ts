export function findUser(id: string): User | null {
  if (!id) return null;
  return { id };
}

interface User {
  id: string;
}
