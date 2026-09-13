# QR-WASH NEON V1

โปรเจกต์ใหม่ แยกจาก Supabase ทั้งหมด

เส้นทาง POC:
Server -> Neon PostgreSQL -> ESP32 -> Pulse

## ขั้นตอน

1. ติดตั้ง Node.js LTS บนคอม
2. เปิด Command Prompt ในโฟลเดอร์โปรเจกต์
3. รัน:
   npm install
4. คัดลอก `.env.example` เป็น `.env`
5. เอา Neon Connection String ที่คัดลอกจากหน้า Connect
   ไปใส่ใน DATABASE_URL
6. รัน:
   npm start
7. เปิด:
   http://localhost:3000

## Database
ถ้าสร้างตารางใน Neon แล้วจากขั้นก่อนหน้า:
ไม่ต้องรัน schema.sql ซ้ำก็ได้

ถ้าตารางยังไม่มี ให้เปิด Neon SQL Editor แล้วรัน:
schema.sql

## POC
กดสร้างรายการ 20 บาท
Server จะสร้าง:
payment = 20 บาท
command = 2 pulse

จากนั้น ESP32 จะเรียก:
GET /api/device/commands

และตอบกลับ:
POST /api/device/ack

## ความปลอดภัย
ห้ามนำ DATABASE_URL ที่มี password ไปใส่ใน ESP32
ห้ามเผยแพร่ `.env`
POC นี้ยังไม่ใช่ระบบรับเงินจริงและยังไม่ต่อ PLC
