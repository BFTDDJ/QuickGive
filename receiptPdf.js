const PDFDocument = require("pdfkit");

function generateReceiptPdf(receipt, donation) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "LETTER", margin: 50 });
      const chunks = [];

      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => {
        const buffer = Buffer.concat(chunks);
        console.log("RECEIPT PDF GENERATED:", receipt.id, "BYTES:", buffer.length);
        resolve(buffer);
      });
      doc.on("error", reject);

      doc.fontSize(20).text("Dono", { align: "left" });
      doc.moveDown();

      doc.fontSize(12).text(`Receipt ID: ${receipt.id}`);
      doc.text(`Donation Amount: $${donation.amount}`);
      doc.text(`Currency: ${donation.currency}`);
      doc.text(`Charity ID: ${donation.charityId || "(placeholder)"}`);
      doc.text(`Date: ${new Date(receipt.createdAt).toISOString()}`);
      doc.moveDown();

      doc.text("This donation is tax-deductible to the extent allowed by law.");

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generateReceiptPdf };
