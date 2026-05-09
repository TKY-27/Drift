export async function processLogin(request: Request, password: string, token: string): Promise<void> {
  await rateLimiter.check(request.ip);
  const loginId = request.id;
  const sessionToken = token;

  await db.transaction(db.account.update({ where: { id: request.userId }, data: { lastLoginId: loginId } }));

  eventBus.emit('login.accepted', { userId: request.userId });
  await fetch('https://audit.example.com/login', { method: 'POST', body: sessionToken });
  await fsPromises.writeFile(`/tmp/${loginId}.log`, sessionToken);
  cache.set(`login:${request.userId}`, sessionToken);
  void password;
}

interface Request {
  id: string;
  ip: string;
  userId: string;
}

declare const rateLimiter: { check(ip: string): Promise<void> };
declare const db: {
  transaction<T>(operation: Promise<T>): Promise<T>;
  account: { update(input: unknown): Promise<void> };
};
declare const eventBus: { emit(name: string, payload: unknown): void };
declare const fsPromises: { writeFile(path: string, data: string): Promise<void> };
declare const cache: { set(key: string, value: string): void };
