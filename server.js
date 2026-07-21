import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import dotenv from 'dotenv';
import { Server } from 'socket.io';
import { createClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
 
dotenv.config();
 
const __dirname = path.dirname(fileURLToPath(import.meta.url));
 
// ---------- Connexions externes ----------
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
 
// ---------- Serveur ----------
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
 
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // sert index.html automatiquement
 
// ================= TÂCHES / PLANNING =================
app.get('/api/tasks', async (req, res) => {
  const { date } = req.query;
  let q = supabase.from('tasks').select('*').order('created_at', { ascending: true });
  if (date) q = q.eq('due_date', date);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});
 
app.post('/api/tasks', async (req, res) => {
  const { title, due_date, assigned_to } = req.body;
  const { data, error } = await supabase
    .from('tasks')
    .insert([{ title, due_date, assigned_to, status: 'todo' }])
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data[0]);
});
 
app.patch('/api/tasks/:id', async (req, res) => {
  const { data, error } = await supabase
    .from('tasks').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data[0]);
});
 
app.delete('/api/tasks/:id', async (req, res) => {
  const { error } = await supabase.from('tasks').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(204).send();
});
 
// ================= FICHIERS =================
app.post('/api/files/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
  const fileName = `${Date.now()}-${req.file.originalname}`;
  const { error } = await supabase.storage
    .from('team-files')
    .upload(fileName, req.file.buffer, { contentType: req.file.mimetype });
  if (error) return res.status(500).json({ error: error.message });
  const { data } = supabase.storage.from('team-files').getPublicUrl(fileName);
  res.status(201).json({ name: req.file.originalname, url: data.publicUrl });
});
 
app.get('/api/files', async (req, res) => {
  const { data, error } = await supabase.storage.from('team-files').list();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data.map((f) => ({
    name: f.name,
    url: supabase.storage.from('team-files').getPublicUrl(f.name).data.publicUrl,
  })));
});
 
// ================= ASSISTANT IA =================
app.post('/api/ai/ask', async (req, res) => {
  try {
    const { message } = req.body;
    const today = new Date().toISOString().slice(0, 10);
    const { data: todayTasks } = await supabase.from('tasks').select('title,status,assigned_to').eq('due_date', today);
    const context = todayTasks?.length
      ? `Tâches du jour (${today}) : ${JSON.stringify(todayTasks)}`
      : `Aucune tâche enregistrée aujourd'hui (${today}).`;
 
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      system: `Tu es l'assistant d'une équipe de 4 youtubeurs qui font du storytelling. ${context} Réponds en français, de façon utile et concise.`,
      messages: [{ role: 'user', content: message }],
    });
 
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    res.json({ reply: text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur IA' });
  }
});
 
// ================= TEMPS RÉEL (chat + musique) =================
let musicState = { url: null, title: null, isPlaying: false, positionSec: 0 };
 
io.on('connection', (socket) => {
  socket.on('chat:message', (msg) => io.emit('chat:message', msg));
 
  socket.on('music:sync', (state) => {
    musicState = state;
    socket.broadcast.emit('music:sync', musicState);
  });
 
  socket.on('music:request-state', () => socket.emit('music:sync', musicState));
});
 
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Team Hub lancé sur le port ${PORT}`));
