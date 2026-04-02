import express from "express";
import cors from "cors";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CreateBucketCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const app = express();
app.use(cors());
app.use(express.json());

// Konfigurasi RustFS (kompatibel S3)
const s3 = new S3Client({
  endpoint: "http://localhost:9000",   // RustFS local
  region: "us-east-1",                // wajib diisi, tapi bebas nilainya
  credentials: {
    accessKeyId: process.env.RUSTFS_ACCESS_KEY,
    secretAccessKey: process.env.RUSTFS_SECRET_KEY,
  },
  forcePathStyle: true,               // PENTING: RustFS/MinIO pakai path-style
});

const BUCKET = "demo-bucket";

//  Auto-create bucket saat server start
async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    console.log(`Bucket "${BUCKET}" sudah ada`);
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    console.log(`Bucket "${BUCKET}" berhasil dibuat`);
  }
}

// atau bisa seperti ini 
// const BUCKET = process.env.BUCKET_NAME;
// async function ensureBucket() {
//   try {
//     await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
//   } catch (err) {
//     if (err.name === "NotFound") {
//       // Dev: auto-create
//       if (process.env.NODE_ENV !== "production") {
//         await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
//         console.log("Bucket dibuat (dev mode)");
//       } else {
//         // Prod: crash dengan pesan jelas daripada diam-diam gagal
//         throw new Error(`Bucket "${BUCKET}" tidak ditemukan. Buat manual dulu.`);
//       }
//     }
//   }
// }

//  Routes

// GET /presign/upload?filename=foto.jpg&type=image/jpeg
// Kembalikan presigned URL untuk upload (PUT)
app.get("/presign/upload", async (req, res) => {
  const { filename, type = "application/octet-stream" } = req.query;
  if (!filename) return res.status(400).json({ error: "filename wajib diisi" });

  const key = `uploads/${Date.now()}-${filename}`;

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    ContentType: type,
  });

  // URL berlaku 10 menit
  const url = await getSignedUrl(s3, command, { expiresIn: 600 });

  res.json({ url, key, expiresIn: 600 });
});

// Gabungan antara key pakai UUID + filename dari client
// serta beberapa validasi MIME type dan ekstensi
// app.get("/presign/upload", async (req, res) => {
//   const { filename, type } = req.query;
//   const userId = req.user.id;

//   if (!userId) {
//     return res.status(401).json({ error: "Unauthorized" });
//   }

//   if (!filename || !type) {
//     return res.status(400).json({ error: "filename dan type wajib diisi" });
//   }

//   //  Whitelist MIME type
//   //  Kamu juga bisa tambahkan type lain sesuai kebutuhan
//   const allowedTypes = [
//     "image/jpeg",
//     "image/png",
//     "image/webp",
//     "application/pdf",
//   ];

//   if (!allowedTypes.includes(type)) {
//     return res.status(400).json({ error: "Tipe file tidak diizinkan" });
//   }

//   //  Validasi ekstensi
//   const ext = filename.split(".").pop().toLowerCase();
//   const allowedExt = ["jpg", "jpeg", "png", "webp", "pdf"];

//   if (!allowedExt.includes(ext)) {
//     return res.status(400).json({ error: "Ekstensi file tidak valid" });
//   }

//   //  Mapping MIME ↔ ekstensi (biar gak mismatch)
//   const mimeToExt = {
//     "image/jpeg": ["jpg", "jpeg"],
//     "image/png": ["png"],
//     "image/webp": ["webp"],
//     "application/pdf": ["pdf"],
//   };

//   if (!mimeToExt[type].includes(ext)) {
//     return res.status(400).json({
//       error: "Mismatch antara MIME type dan ekstensi file",
//     });
//   }

//   // Generate key aman (tidak pakai nama asli)
//   const key = `users/${userId}/${randomUUID()}.${ext}`;

//   // Simpan metadata ke DB
//   await db.files.create({
//     key,
//     originalName: filename,
//     mimeType: type,
//     uploadedBy: userId,
//   });

//   // Optional: batasi ukuran file via metadata (hint ke client)
//   const MAX_SIZE = 5 * 1024 * 1024; // 5MB

//   const command = new PutObjectCommand({
//     Bucket: BUCKET,
//     Key: key,
//     ContentType: type,

//     // Ini tidak enforce keras di semua S3-compatible,
//     // tapi tetap bagus sebagai hint / tambahan kontrol
//     ContentLength: MAX_SIZE,
//   });

//   const url = await getSignedUrl(s3, command, { expiresIn: 600 });

//   res.json({
//     url,
//     key,
//     expiresIn: 600,
//     maxSize: MAX_SIZE,
//   });
// });

// GET /presign/download?key=uploads/xxx.jpg
// Kembalikan presigned URL untuk download (GET)
app.get("/presign/download", async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: "key wajib diisi" });

  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  const url = await getSignedUrl(s3, command, { expiresIn: 300 });

  res.json({ url, expiresIn: 300 });
});

// GET /files List semua file di bucket
app.get("/files", async (req, res) => {
  const result = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "uploads/" })
  );

  const files = (result.Contents || []).map((obj) => ({
    key: obj.Key,
    size: obj.Size,
    lastModified: obj.LastModified,
  }));

  res.json({ files });
});

// DELETE /files?key=uploads/xxx.jpg Hapus file
app.delete("/files", async (req, res) => {
  const { key } = req.query;
  if (!key) return res.status(400).json({ error: "key wajib diisi" });

  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  res.json({ message: "File berhasil dihapus", key });
});

// Start
const PORT = 3000;
app.listen(PORT, async () => {
  await ensureBucket();
  console.log(`\nServer berjalan di http://localhost:${PORT}`);
  console.log(`\nEndpoints:`);
  console.log(`  GET  /presign/upload?filename=foto.jpg&type=image/jpeg`);
  console.log(`  GET  /presign/download?key=uploads/xxx.jpg`);
  console.log(`  GET  /files`);
  console.log(`  DELETE /files?key=uploads/xxx.jpg`);
});