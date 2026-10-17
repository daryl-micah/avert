import type { Request, Response } from 'express';
import { chargeCustomer } from './billing';

export async function handleCheckout(req: Request, res: Response) {
  const intent = await chargeCustomer(req.body);
  res.json({ id: intent.id, status: intent.status });
}
