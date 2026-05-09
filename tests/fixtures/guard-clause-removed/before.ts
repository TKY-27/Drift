export async function createInvoice(input: InvoiceInput): Promise<void> {
  validateInvoice(input);
  await authorize(input.userId);
  await db.invoice.create({ data: input });
}

interface InvoiceInput {
  userId: string;
}

declare function validateInvoice(input: InvoiceInput): void;
declare function authorize(userId: string): Promise<void>;
declare const db: { invoice: { create(input: unknown): Promise<void> } };
