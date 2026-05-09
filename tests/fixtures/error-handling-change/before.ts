export async function loadProfile(id: string): Promise<Profile | null> {
  try {
    return await repository.find(id);
  } catch (error) {
    throw error;
  }
}

interface Profile {
  id: string;
}

declare const repository: { find(id: string): Promise<Profile | null> };
