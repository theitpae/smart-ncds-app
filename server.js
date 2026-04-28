const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public')); // เก็บไฟล์ Index.html ไว้ในโฟลเดอร์ public

// 🟢 อัปเดตการเชื่อมต่อ PostgreSQL เป็น External URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://netadmin:P1pFjWIWoTpYfnsMDDDuGXoFVLph4adT@dpg-d7o3mv3bc2fs7395vjog-a.singapore-postgres.render.com/osmdb',
  ssl: { rejectUnauthorized: false } // จำเป็นเมื่อเชื่อมต่อผ่าน External URL
});

// ฟังก์ชันเข้ารหัสผ่าน (SHA-256)
function hashPassword(password) {
  return crypto.createHash('sha256').update(String(password)).digest('hex');
}

// ==========================================
// API ENDPOINT หลัก (จำลองการทำงานของ google.script.run)
// ==========================================
app.post('/api/run/:method', async (req, res) => {
  const { method } = req.params;
  const args = req.body.args || [];
  
  try {
    // 1. ระบบ Login & Password
    if (method === 'login') {
      const [username, password] = args;
      const inputHash = hashPassword(password);
      const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      
      if (rows.length > 0 && (rows[0].password_hash === String(password) || rows[0].password_hash === inputHash)) {
        res.json({ status: 'success', user: { id: rows[0].id, name: rows[0].name, role: rows[0].role, zone: rows[0].zone } });
      } else {
        res.json({ status: 'error', message: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
      }
    } 
    else if (method === 'changeUserPassword') {
      const [userId, newPassword] = args;
      await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hashPassword(newPassword), userId]);
      res.json({ status: 'success', message: 'เปลี่ยนรหัสผ่านสำเร็จ' });
    }

    // 2. ระบบตั้งค่าระบบ (LINE)
    else if (method === 'getSystemConfig') {
      const { rows } = await pool.query('SELECT * FROM config');
      let conf = { line_token: '', line_target_id: '', line_status: 'off' };
      rows.forEach(r => conf[r.config_key] = r.config_value);
      res.json(conf);
    }
    else if (method === 'saveSystemConfigs') {
      const [configs] = args;
      for (let key in configs) {
        await pool.query(
          'INSERT INTO config (config_key, config_value) VALUES ($1, $2) ON CONFLICT (config_key) DO UPDATE SET config_value = $2',
          [key, configs[key]]
        );
      }
      res.json({status: 'success'});
    }

    // 3. โหลดข้อมูล Dashboard
    else if (method === 'getDashboardData') {
      const [role, userId] = args;
      const isAdmin = role === 'admin';
      
      const patRes = isAdmin ? await pool.query('SELECT * FROM patients') : await pool.query('SELECT * FROM patients WHERE current_osm = $1', [userId]);
      const recRes = isAdmin ? await pool.query('SELECT * FROM records ORDER BY record_date DESC') : await pool.query('SELECT * FROM records WHERE user_id = $1 ORDER BY record_date DESC', [userId]);
      
      const highRisk = recRes.rows.filter(r => r.fbs > 126 || r.bp_sys > 140).length;
      const mapData = patRes.rows.filter(p => p.lat && p.lng).map(p => ({ pid: p.id, name: p.name, lat: p.lat, lng: p.lng, disease: p.disease }));
      const tickets = recRes.rows.filter(r => r.wellness === 'ต้องเฝ้าระวัง').slice(0, 10).map(r => ({ date: r.record_date, pid: r.patient_id, fbs: r.fbs, sys: r.bp_sys }));

      let leaderboard = [];
      if (isAdmin) {
         const lbRes = await pool.query("SELECT u.name, u.zone, COUNT(r.id) as count FROM users u LEFT JOIN records r ON u.id = r.user_id WHERE u.role = 'osm' GROUP BY u.id, u.name, u.zone ORDER BY count DESC LIMIT 5");
         leaderboard = lbRes.rows;
      }

      res.json({ status: 'success', data: { 
        totalPatients: patRes.rowCount, 
        highRisk: highRisk, 
        recordsThisMonth: recRes.rowCount, 
        chartData: { 
            labels: recRes.rows.slice(0,10).reverse().map(r => new Date(r.record_date).getDate() + '/' + (new Date(r.record_date).getMonth()+1)), 
            fbs: recRes.rows.slice(0,10).reverse().map(r=>r.fbs), 
            sys: recRes.rows.slice(0,10).reverse().map(r=>r.bp_sys) 
        }, 
        patientList: patRes.rows.map(p => ({ pid: p.id, name: p.name, disease: p.disease })), 
        mapData: mapData, 
        tickets: tickets, 
        leaderboard: leaderboard 
      }});
    }

    // 4. บันทึก NCDs Record
    else if (method === 'saveNCDRecord') {
      const [formData] = args;
      const rid = "REC" + new Date().getTime();
      const weight = parseFloat(formData.weight) || 0;
      const height = parseFloat(formData.height) || 0;
      const bmi = height > 0 ? (weight / Math.pow(height/100, 2)).toFixed(2) : 0;
      let bmiText = bmi < 18.5 ? "ผอม" : bmi < 25 ? "ท้วม" : bmi < 30 ? "อ้วน" : "อ้วนมาก";

      await pool.query(`INSERT INTO records 
        (id, patient_id, weight, height, bmi, bmi_text, waist, fbs, bp_sys, bp_dia, ls_score, wellness, advice, user_id) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [rid, formData.pid, weight, height, bmi, bmiText, formData.waist || null, formData.fbs || null, formData.bp_sys || null, formData.bp_dia || null, formData.ls_score || null, formData.wellness, formData.advice, formData.userId]
      );
      
      if(formData.lat && formData.lng) {
        await pool.query('UPDATE patients SET lat=$1, lng=$2 WHERE id=$3', [formData.lat, formData.lng, formData.pid]);
      }
      res.json({ status: 'success', bmi: bmi, bmiText: bmiText });
    }

    // 5. Patient Assign (เป้าหมาย)
    else if (method === 'getAdminAssignData') {
      const osmRes = await pool.query("SELECT id, name FROM users WHERE role='osm'");
      const patRes = await pool.query("SELECT id as pid, name, disease, current_osm FROM patients");
      const disRes = await pool.query("SELECT name FROM diseases");
      res.json({ osmList: osmRes.rows, patientList: patRes.rows, diseaseList: disRes.rows.map(d => d.name) });
    }
    else if (method === 'managePatient') {
      const [action, pData] = args;
      if (action === 'add') {
        const { rows } = await pool.query('SELECT id FROM patients WHERE id=$1', [pData.pid]);
        if (rows.length > 0) return res.json({ status: 'error', message: 'รหัสผู้ป่วยนี้มีอยู่แล้ว' });
        await pool.query('INSERT INTO patients (id, name, disease) VALUES ($1, $2, $3)', [pData.pid, pData.name, pData.disease]);
      } else if (action === 'edit') {
        await pool.query('UPDATE patients SET id=$1, name=$2, disease=$3 WHERE id=$4', [pData.pid, pData.name, pData.disease, pData.targetId]);
      } else if (action === 'delete') {
        await pool.query('DELETE FROM patients WHERE id=$1', [pData.targetId]);
      }
      res.json({ status: 'success', message: 'จัดการข้อมูลผู้ป่วยสำเร็จ' });
    }
    else if (method === 'saveAssignments') {
      const [osmId, patientIds] = args;
      for (let pid of patientIds) {
        await pool.query('UPDATE patients SET current_osm=$1 WHERE id=$2', [osmId, pid]);
      }
      res.json({ status: 'success', count: patientIds.length });
    }
    else if (method === 'importPatientsCSV') {
      const [csvDataArray] = args;
      let count = 0;
      for (let row of csvDataArray) {
        if (row.length > 1 && row[0] !== "") {
          await pool.query('INSERT INTO patients (id, name, disease) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [row[0], row[1], row[3] || '']);
          count++;
        }
      }
      res.json({ status: 'success', count: count });
    }

    // 6. User Management
    else if (method === 'getUsersData') {
      const { rows } = await pool.query('SELECT * FROM users');
      res.json(rows.map(u => ({ id: u.id, username: u.username, name: u.name, role: u.role, zone: u.zone })));
    }
    else if (method === 'manageUser') {
      const [action, u] = args;
      if (action === 'add') {
        const newId = "U" + new Date().getTime().toString().slice(-4);
        await pool.query('INSERT INTO users (id, username, password_hash, name, role, zone) VALUES ($1, $2, $3, $4, $5, $6)', [newId, u.username, hashPassword('1234'), u.name, u.role, u.zone]);
      } else if (action === 'edit') {
        await pool.query('UPDATE users SET username=$1, name=$2, role=$3, zone=$4 WHERE id=$5', [u.username, u.name, u.role, u.zone, u.id]);
      } else if (action === 'reset') {
        await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword('1234'), u.id]);
      } else if (action === 'delete') {
        await pool.query('DELETE FROM users WHERE id=$1', [u.id]);
      }
      res.json({ status: 'success', message: 'จัดการผู้ใช้งานสำเร็จ' });
    }

    // 7. Diseases CRUD
    else if (method === 'getDiseaseMasterData') {
      const { rows } = await pool.query('SELECT * FROM diseases');
      res.json(rows);
    }
    else if (method === 'manageDiseaseMaster') {
      const [action, payload] = args;
      if (action === 'add') {
        const newId = "DS" + new Date().getTime().toString().slice(-4);
        await pool.query('INSERT INTO diseases (id, name) VALUES ($1, $2)', [newId, payload.name]);
      } else if (action === 'edit') {
        await pool.query('UPDATE diseases SET name=$1 WHERE id=$2', [payload.name, payload.id]);
      } else if (action === 'delete') {
        await pool.query('DELETE FROM diseases WHERE id=$1', [payload.id]);
      }
      res.json({ status: 'success', message: 'จัดการข้อมูลโรคสำเร็จ' });
    }

    // 8. HealthCenters CRUD
    else if (method === 'getHealthCenters') {
      const { rows } = await pool.query('SELECT * FROM health_centers');
      res.json(rows);
    }
    else if (method === 'manageHealthCenter') {
      const [action, payload] = args;
      if (action === 'add') {
        const newId = "HC" + new Date().getTime().toString().slice(-4);
        await pool.query('INSERT INTO health_centers (id, name, affiliation, address, tel, lat, lng) VALUES ($1, $2, $3, $4, $5, $6, $7)', [newId, payload.name, payload.affiliation, payload.address, payload.tel, payload.lat, payload.lng]);
      } else if (action === 'edit') {
        await pool.query('UPDATE health_centers SET name=$1, affiliation=$2, address=$3, tel=$4, lat=$5, lng=$6 WHERE id=$7', [payload.name, payload.affiliation, payload.address, payload.tel, payload.lat, payload.lng, payload.id]);
      } else if (action === 'delete') {
        await pool.query('DELETE FROM health_centers WHERE id=$1', [payload.id]);
      }
      res.json({ status: 'success', message: 'จัดการหน่วยงานสำเร็จ' });
    }

    // หากไม่ตรงกับฟังก์ชันใดๆ
    else {
      res.json({ status: 'error', message: 'Method Not Found' });
    }

  } catch (err) {
    console.error(`[API Error in ${method}]:`, err);
    res.json({ status: 'error', message: err.message });
  }
});

// ให้รันหน้าเว็บ index.html เมื่อเปิดหน้าแรก
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// เริ่มต้น Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));