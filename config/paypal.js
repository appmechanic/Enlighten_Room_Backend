// PayPal SDK setup for Node.js
import checkoutNodeJssdk from '@paypal/checkout-server-sdk';

// Environment setup (sandbox for dev, live for prod)
function environment() {
  const clientId = 'ASB9eIz1MaXhbM3gIbfgJU9_7w6QHWknUDsZDCn-p5x45liJWIJob-mNpXEcp-XkMLDtrHdaanjGDVdL';
  const clientSecret = 'ENsKHzWbOAPxie91dJLyuUqF0xnpuANoOyNi-y_9VG8WzLlWMrClQQCCMikdfRy9TnGmT5mTNNsKdQvI';
  if (process.env.NODE_ENV === 'production') {
    return new checkoutNodeJssdk.core.LiveEnvironment(clientId, clientSecret);
  }
  return new checkoutNodeJssdk.core.SandboxEnvironment(clientId, clientSecret);
}

export function paypalClient() {
  return new checkoutNodeJssdk.core.PayPalHttpClient(environment());
}
