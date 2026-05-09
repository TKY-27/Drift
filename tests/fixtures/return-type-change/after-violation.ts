export function findUser(id: string): User {
  if (!id) throw new Error('missing id');
  return { id };
}

interface User {
  id: string;
}
