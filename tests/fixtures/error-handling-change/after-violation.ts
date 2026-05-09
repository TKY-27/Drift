export async function loadProfile(id: string): Promise<Profile | null> {
  try {
    return await repository.find(id);
  } catch (error) {
    console.error(error);
    return null;
  }
}

interface Profile {
  id: string;
}

declare const repository: { find(id: string): Promise<Profile | null> };
