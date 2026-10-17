import express from 'express';
import { handleCheckout } from './handlers';

const app = express();
app.use(express.json());

app.post('/checkout', handleCheckout);

app.listen(3000);
