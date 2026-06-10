import nodemailer from 'nodemailer';

const STORE_NAME    = process.env.STORE_NAME    || 'South Devon Chilli Farm';
const STORE_EMAIL   = process.env.STORE_EMAIL   || 'orders@sdcf.co.uk';
const STORE_WEBSITE = process.env.STORE_WEBSITE || 'https://southdevonchillifarm.co.uk';
const STORE_ADDRESS = process.env.STORE_ADDRESS || 'Wigford Cross, Loddiswell, Kingsbridge TQ7 4DX';
const STORE_EORI    = process.env.STORE_EORI    || 'GB885490630200';

let _transporter = null;

function getTransporter() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: Number(process.env.EMAIL_PORT || 587),
    secure: process.env.EMAIL_SECURE === 'true', // true for 465, false for 587
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS, // Gmail App Password
    },
  });
  return _transporter;
}

export function isConfigured() {
  return Boolean(process.env.EMAIL_USER && process.env.EMAIL_PASS);
}

function buildEmailHtml(order, trackingInfo) {
  const c  = order.customer || {};
  const sa = order.shipping_address || {};
  const firstName = c.first_name || sa.name?.split(' ')[0] || 'Customer';

  const orderUrl = order.order_status_url
    || `${STORE_WEBSITE.startsWith('http') ? STORE_WEBSITE : 'https://' + STORE_WEBSITE}/account/orders/${order.id}`;

  const storeUrl = STORE_WEBSITE.startsWith('http')
    ? STORE_WEBSITE
    : `https://${STORE_WEBSITE}`;

  const itemsHtml = (order.line_items || []).map(li => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#333;">
        ${li.title}${li.variant_title && li.variant_title !== 'Default Title' ? ' — ' + li.variant_title : ''}
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-size:14px;color:#333;text-align:right;white-space:nowrap;">
        × ${li.quantity}
      </td>
    </tr>`).join('');

  const trackingHtml = trackingInfo?.trackingNumber ? `
    <div style="margin:15px 0;padding:12px 16px;background:#f0f9f0;border-left:3px solid #4caf50;border-radius:4px;">
      <p style="margin:0;font-size:14px;color:#333;">
        <strong>Tracking number:</strong> ${trackingInfo.trackingNumber}
        ${trackingInfo.carrier === 'Royal Mail'
          ? `<br><a href="https://www.royalmail.com/track-your-item#/tracking-results/${trackingInfo.trackingNumber}" style="color:#c00;font-size:13px;">Track your parcel →</a>`
          : trackingInfo.carrier === 'DPD'
          ? `<br><a href="https://www.dpd.co.uk/apps/tracking/?ref=${trackingInfo.trackingNumber}" style="color:#dc6b00;font-size:13px;">Track your parcel →</a>`
          : ''}
      </p>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Your order is on its way!</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:20px 0;">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

      <!-- HEADER -->
      <tr>
        <td style="padding:20px 30px;border-bottom:2px solid #cc0000;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="font-size:18px;font-weight:bold;color:#cc0000;">${STORE_NAME}</td>
              <td align="right" style="font-size:13px;color:#888;font-weight:500;">ORDER #${order.order_number}</td>
            </tr>
          </table>
        </td>
      </tr>

      <!-- BODY -->
      <tr><td style="padding:30px;">

        <p style="font-size:22px;font-weight:600;color:#111;margin:0 0 16px;">Hi ${firstName},</p>

        <p style="font-size:15px;color:#555;line-height:1.6;margin:0 0 20px;">
          Your order is on its way. Thank you for choosing us and we hope you enjoy our
          products. If there are any issues with your order, please reply to this email address.
        </p>

        ${trackingHtml}

        <!-- CTA Button -->
        <table cellpadding="0" cellspacing="0" style="margin-bottom:12px;">
          <tr>
            <td bgcolor="#cc0000" style="border-radius:4px;">
              <a href="${orderUrl}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:bold;color:#fff;text-decoration:none;border-radius:4px;">
                View your order
              </a>
            </td>
          </tr>
        </table>

        <p style="font-size:13px;color:#777;margin:0 0 28px;">
          or <a href="${storeUrl}" style="color:#555;">Visit our store</a>
        </p>

        <!-- Items -->
        <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #eee;">
          <tr><td style="padding:20px 0 10px;">
            <p style="margin:0;font-size:16px;font-weight:700;color:#111;">Items in this shipment</p>
          </td></tr>
          ${itemsHtml}
        </table>

        <!-- Delivery notes -->
        <p style="font-size:14px;color:#555;line-height:1.7;margin:20px 0 12px;">
          If you have selected the &ldquo;Collect From Farm&rdquo; shipping option then this is now
          ready to be collected from our customer collection box at the farm shop.
        </p>
        <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 12px;">
          If you have ordered fresh chillies or plants, we pick and send them out from Monday through
          to Thursday for orders placed on Monday, Tuesday, or Wednesday. Note, if your order was
          placed on Thursday through to Sunday, your order will not be sent out until the following
          Monday. This is to ensure that the products are as fresh as possible.
        </p>
        <p style="font-size:14px;color:#555;line-height:1.7;margin:0 0 20px;">
          If you have any comments on the products in your order, or the service we have provided,
          please help us by replying to this email or leave your reviews on the product page.
          Thanks again for your support.
        </p>

        <p style="font-size:14px;font-weight:600;color:#333;margin:0 0 16px;">${STORE_NAME} Ltd.</p>

        <!-- UK Plant Passport -->
        <div style="border:1px solid #ddd;border-radius:4px;padding:14px 16px;font-size:13px;color:#555;line-height:2;">
          <strong style="display:block;margin-bottom:4px;color:#333;">UK Plant Passport</strong>
          A Variety: see packet/label<br>
          B 100561<br>
          C<br>
          D GB<br>
          E
        </div>

      </td></tr>

      <!-- FOOTER -->
      <tr>
        <td style="padding:20px 30px;background:#f8f8f8;border-top:1px solid #eee;">
          <p style="margin:0;font-size:12px;color:#999;line-height:1.8;text-align:center;">
            ${STORE_NAME} · ${STORE_ADDRESS}<br>
            <a href="mailto:${STORE_EMAIL}" style="color:#999;">${STORE_EMAIL}</a> ·
            <a href="${storeUrl}" style="color:#999;">${STORE_WEBSITE}</a><br>
            EORI No: ${STORE_EORI}
          </p>
        </td>
      </tr>

    </table>
  </td></tr>
</table>
</body>
</html>`;
}

/**
 * Send a dispatch notification email for a single order.
 * trackingInfo: { trackingNumber, carrier } — optional
 */
export async function sendOrderNotification(order, trackingInfo = null) {
  const transporter = getTransporter();

  const c  = order.customer || {};
  const sa = order.shipping_address || {};
  const toEmail = c.email || order.email || sa.email;
  if (!toEmail) throw new Error(`No email address for order #${order.order_number}`);

  const toName = `${c.first_name || ''} ${c.last_name || ''}`.trim() || sa.name || toEmail;

  const fromAddress = process.env.EMAIL_FROM
    || `"${STORE_NAME}" <${process.env.EMAIL_USER}>`;

  const info = await transporter.sendMail({
    from: fromAddress,
    to: `"${toName}" <${toEmail}>`,
    subject: `Your order #${order.order_number} is on its way! 🌶️`,
    html: buildEmailHtml(order, trackingInfo),
  });

  return { messageId: info.messageId, toEmail };
}
