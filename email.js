const { Resend } = require("resend");
const { generateReceiptPdf } = require("./receiptPdf");

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendReceiptEmail(toEmail, receipt, donation) {
  let attachments = [];
  let pdfBuffer;
  try {
    pdfBuffer = await generateReceiptPdf(receipt, donation);
    attachments = [
      {
        filename: `Dono_Receipt_${receipt.id}.pdf`,
        content: pdfBuffer
      }
    ];
  } catch (err) {
    console.error("RECEIPT PDF GENERATION FAILED:", err);
  }

  if (!toEmail) {
    return { response: null, pdfBuffer };
  }

  const response = await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to: toEmail,
    subject: "Your Dono Receipt",
    html: `
      <h2>Thank you for your donation</h2>
      <p><strong>Amount:</strong> $${donation.amount}</p>
      <p><strong>Date:</strong> ${new Date(receipt.createdAt).toLocaleDateString()}</p>
      <p><strong>Receipt ID:</strong> ${receipt.id}</p>
      <p>This email confirms your donation for your records.</p>
    `,
    attachments
  });

  if (response?.error) {
    throw response.error;
  }

  console.log("RECEIPT EMAIL SENT TO:", toEmail, "RECEIPT ID:", receipt.id);
  return { response, pdfBuffer };
}

module.exports = { sendReceiptEmail };

async function sendPasswordResetEmail(toEmail, resetUrl) {
  const response = await resend.emails.send({
    from: process.env.FROM_EMAIL,
    to: toEmail,
    subject: "Reset your Dono password",
    html: `
      <h2>Reset your password</h2>
      <p>Click the link below to reset your password:</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>If you did not request this, you can ignore this email.</p>
    `
  });

  if (response?.error) {
    throw response.error;
  }

  console.log("PASSWORD RESET EMAIL SENT TO:", toEmail);
  return response;
}

module.exports.sendPasswordResetEmail = sendPasswordResetEmail;
