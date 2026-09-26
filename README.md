# เฝ้าระวังน้ำท่วมไทย

แดชบอร์ดสถานการณ์น้ำท่วมแบบเรียลไทม์ (static site บน GitHub Pages)

- **ระดับน้ำ / ฝน 24 ชม. / เขื่อน**: เบราว์เซอร์ดึงจาก ThaiWater (`api-v3.thaiwater.net`) โดยตรงทุก 5 นาที
- **GDACS**: เหตุการณ์น้ำท่วมในไทย 45 วันล่าสุด
- **ข่าว + โพสต์ X #น้ำท่วม**: GitHub Actions รัน `scripts/build-feed.mjs` ทุก ~10 นาที แล้ว deploy `site/data/feed.json`

## เปิดฟีด X ในหน้าเว็บ
X ไม่อนุญาตให้ฝังผลการค้นหา ต้องใช้ X API (มีค่าใช้จ่าย) ใส่ Bearer Token เป็น repo secret:

```
gh secret set X_BEARER_TOKEN
```

ถ้าไม่มี token หน้าเว็บจะแสดงปุ่มเปิดฟีดสดบน X แทน

## รันในเครื่อง
```
node scripts/build-feed.mjs
python -m http.server -d site 8765
```

## โพสต์จากชุมชน (api/)
ผู้เข้าเว็บแชร์ลิงก์โพสต์ X / Facebook ได้เอง เก็บใน Vercel Blob (private) ผ่าน API บน Vercel
`https://thai-flood-watch-api.vercel.app/api/posts`

- โพสต์ขึ้นทันที · ส่งได้ 5 ครั้ง/10 นาที ต่อ IP · ถูกรายงาน 3 ครั้ง (หรือผู้แชร์รายงานเอง) จะซ่อนอัตโนมัติ
- ผู้ดูแล: เปิดหน้าเว็บด้วย `#admin` แล้วใส่รหัส (อยู่ในไฟล์ `api/.admin-key` ในเครื่อง ไม่ขึ้น git) เพื่อดูโพสต์ที่ถูกซ่อน ซ่อน/แสดง/ลบ
- Deploy API: `cd api && vercel deploy --prod`
