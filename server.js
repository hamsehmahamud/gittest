const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());
app.use(express.static(__dirname));

const orders = [];

function makeOrder(body, status = 'Pending Payment') {
  const order = {
    id: body.orderId || `EX-${Date.now()}`,
    exchangeType: body.exchangeType,
    amount: Number(body.amount || 0).toFixed(2),
    currency: body.currency || 'USD',
    paymentMethod: body.paymentMethod,
    customerName: body.customerName,
    customerPhone: body.customerPhone || '',
    walletAddress: body.walletAddress,
    network: body.network,
    estimatedReceive: body.estimatedReceive,
    notes: body.notes || '',
    status,
    checkoutUrl: '',
    providerResponse: null,
    txHash: '',
    createdAt: new Date().toISOString()
  };
  orders.unshift(order);
  return order;
}

function extractCheckoutUrl(data) {
  if (!data || typeof data !== 'object') return null;
  return data.checkout_url || data.checkoutUrl || data.payment_url || data.paymentUrl || data.redirect_url || data.redirectUrl || data.url || data.link || data.payment_link || data.paymentLink || (data.data && extractCheckoutUrl(data.data)) || null;
}

function normalizeGateway(method) {
  const map = {
    Zaad: process.env.SIFALO_GATEWAY_ZAAD || 'zaad',
    Edahab: process.env.SIFALO_GATEWAY_EDAHAB || 'edahab',
    'Premier Bank': process.env.SIFALO_GATEWAY_PREMIER || 'premier',
    'Other Local Payment': process.env.SIFALO_GATEWAY_OTHER || 'manual',
    Card: process.env.SIFALO_GATEWAY_CARD || 'card',
    Visa: process.env.SIFALO_GATEWAY_VISA || 'visa',
    Mastercard: process.env.SIFALO_GATEWAY_MASTERCARD || 'mastercard',
    'American Express': process.env.SIFALO_GATEWAY_AMEX || 'american_express',
    'Apple Pay': process.env.SIFALO_GATEWAY_APPLE_PAY || 'apple_pay',
    'Google Pay': process.env.SIFALO_GATEWAY_GOOGLE_PAY || 'google_pay',
    'WeChat Pay': process.env.SIFALO_GATEWAY_WECHAT_PAY || 'wechat_pay',
    Discover: process.env.SIFALO_GATEWAY_DISCOVER || 'discover'
  };
  return map[method] || String(method || '').toLowerCase();
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/payment-success', (req, res) => {
  res.send('<h2>Payment success</h2><p>Payment returned from provider. Admin will verify and manually send USDT.</p><p><a href="/">Back Home</a></p>');
});

app.get('/payment-cancel', (req, res) => {
  res.send('<h2>Payment cancelled</h2><p>Your payment was cancelled.</p><p><a href="/">Back Home</a></p>');
});

app.post('/api/sifalopay/create-payment', async (req, res) => {
  try {
    const body = req.body || {};
    const { amount, paymentMethod, customerName, walletAddress } = body;

    if (!amount || Number(amount) <= 0 || !paymentMethod || !customerName || !walletAddress) {
      return res.status(400).json({ success: false, message: 'Amount, payment method, customer name, and USDT wallet address are required.' });
    }

    const onlineMethods = ['Card', 'Visa', 'Mastercard', 'American Express', 'Apple Pay', 'Google Pay', 'WeChat Pay', 'Discover', 'PayPal'];
    const isOnline = onlineMethods.includes(paymentMethod);
    const order = makeOrder(body, isOnline ? 'Pending SifaloPay Checkout' : 'Pending Manual Payment');

    if (paymentMethod === 'PayPal') {
      const paypalUrl = process.env.PAYPAL_CHECKOUT_URL;
      if (paypalUrl) {
        const url = new URL(paypalUrl);
        url.searchParams.set('amount', order.amount);
        url.searchParams.set('currency', order.currency);
        url.searchParams.set('reference', order.id);
        order.checkoutUrl = url.toString();
        return res.json({ success: true, mode: 'live', order, checkoutUrl: order.checkoutUrl });
      }
      return res.json({ success: true, mode: 'demo', order, message: 'PayPal needs PAYPAL_CHECKOUT_URL or real PayPal API.' });
    }

    const apiBase = process.env.SIFALOPAY_API_BASE || 'https://api.sifalopay.com';
    const endpoint = process.env.SIFALOPAY_CREATE_PAYMENT_ENDPOINT || '/gateway/';
    const apiKey = process.env.SIFALOPAY_API_KEY || process.env.SIFALO_API_KEY;

    if (!apiKey) {
      return res.json({ success: true, mode: 'demo', order, message: 'Demo order created. Add SIFALOPAY_API_KEY in .env for live SifaloPay checkout.' });
    }

    const gateway = normalizeGateway(paymentMethod);
    const account = body.customerPhone || process.env.SIFALO_DEFAULT_ACCOUNT || '';

    const payload = {
      account,
      gateway,
      amount: String(order.amount),
      currency: order.currency,
      order_id: order.id,
      // Extra fields. SifaloPay may ignore unknown fields, but they help if hosted checkout supports redirect/webhook.
      customer_name: order.customerName,
      return_url: process.env.SIFALOPAY_RETURN_URL || 'http://localhost:3000/payment-success',
      cancel_url: process.env.SIFALOPAY_CANCEL_URL || 'http://localhost:3000/payment-cancel',
      webhook_url: process.env.SIFALOPAY_WEBHOOK_URL || 'http://localhost:3000/api/sifalopay/webhook',
      metadata: {
        exchangeType: order.exchangeType,
        walletAddress: order.walletAddress,
        network: order.network,
        estimatedReceive: order.estimatedReceive,
        notes: order.notes
      }
    };

    const url = `${apiBase.replace(/\/$/, '')}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const provider = await response.json().catch(() => ({}));
    order.providerResponse = provider;

    if (!response.ok) {
      order.status = 'SifaloPay Error';
      return res.status(response.status).json({ success: false, message: provider.message || provider.error || 'SifaloPay request failed.', provider, order });
    }

    const checkoutUrl = extractCheckoutUrl(provider);
    if (checkoutUrl) {
      order.checkoutUrl = checkoutUrl;
      order.status = 'Checkout Link Created';
    } else {
      order.status = 'Payment Request Sent - Waiting Confirmation';
    }

    return res.json({ success: true, mode: 'live', order, provider, checkoutUrl });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
});

app.post('/api/sifalopay/webhook', (req, res) => {
  const event = req.body || {};
  const reference = event.order_id || event.reference || event.orderId || event.id;
  const order = orders.find(o => o.id === reference);
  if (order) {
    order.status = event.status || event.payment_status || 'Paid - Waiting Manual USDT Send';
    order.providerEvent = event;
    order.updatedAt = new Date().toISOString();
  }
  res.json({ received: true });
});

app.get('/api/admin/orders', (req, res) => res.json({ orders }));

app.post('/api/admin/orders/:id/mark-paid', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  order.status = 'Paid - Waiting Manual USDT Send';
  order.updatedAt = new Date().toISOString();
  res.json({ success: true, order });
});

app.post('/api/admin/orders/:id/mark-sent', (req, res) => {
  const order = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
  order.status = 'USDT Sent';
  order.txHash = req.body.txHash || '';
  order.sentAt = new Date().toISOString();
  res.json({ success: true, order });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Crypto exchange running on http://localhost:${port}`));
