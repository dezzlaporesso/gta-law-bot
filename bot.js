const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const FlexSearch = require('flexsearch');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!TELEGRAM_TOKEN || !OPENROUTER_API_KEY) {
  console.error("ОШИБКА: Не заданы переменные окружения TELEGRAM_TOKEN или OPENROUTER_API_KEY!");
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const index = new FlexSearch.Document({ document: { id: "id", index: ["text"] } });
let chunks = [];
let chunkIdCounter = 0;

function loadAndIndexLaws() {
  const lawsDir = path.join(process.cwd(), 'laws');
  if (!fs.existsSync(lawsDir)) {
    console.log("ОШИБКА: Папка laws не найдена.");
    return;
  }
  const files = fs.readdirSync(lawsDir);
  files.forEach(file => {
    if (path.extname(file).toLowerCase() === '.txt') {
      const content = fs.readFileSync(path.join(lawsDir, file), 'utf-8');
      const fileChunks = content.split(/\n\s*\n/);
      let currentChunk = "";
      fileChunks.forEach(paragraph => {
        if (currentChunk.length + paragraph.length > 1500) {
          if (currentChunk.trim()) chunks.push({ id: chunkIdCounter++, text: currentChunk, source: file });
          currentChunk = paragraph;
        } else {
          currentChunk += "\n\n" + paragraph;
        }
      });
      if (currentChunk.trim()) chunks.push({ id: chunkIdCounter++, text: currentChunk, source: file });
    }
  });
  chunks.forEach(chunk => index.add(chunk));
  console.log(`✅ Загружено ${chunks.length} фрагментов законов.`);
}

loadAndIndexLaws();

function searchLaws(query) {
  const results = index.search(query, { limit: 3, enrich: true });
  let context = "";
  if (results.length > 0) {
    results.forEach(result => {
      result.result.forEach(id => {
        const chunk = chunks.find(c => c.id === id);
        if (chunk) context += `[Источник: ${chunk.source}]\n${chunk.text}\n\n`;
      });
    });
  }
  return context;
}

async function askAI(userQuestion) {
  if (chunks.length === 0) return "База знаний пуста.";
  const relevantContext = searchLaws(userQuestion);
  if (!relevantContext) return "В базе законов нет информации по этому вопросу.";

  const systemPrompt = `Ты — строгий юридический ассистент GTA 5 RP. Отвечай ИСКЛЮЧИТЕЛЬНО на основе фрагментов ниже. Указывай статью.\n\nФРАГМЕНТЫ:\n${relevantContext}`;

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'meta-llama/llama-3-8b-instruct:free',
        messages: [ { role: 'system', content: systemPrompt }, { role: 'user', content: userQuestion } ],
        temperature: 0.1
      })
    });
    const data = await response.json();
    if (data.error) {
      console.error("OpenRouter Error:", data.error);
      return "Ошибка нейросети: " + data.error.message;
    }
    return data.choices[0].message.content;
  } catch (error) {
    console.error(error);
    return "Ошибка при соединении с нейросетью.";
  }
}

bot.on('message', async (msg) => {
  if (msg.text === '/start') return bot.sendMessage(msg.chat.id, "Привет! Я бот-юрист. Задай вопрос по законам.");
  bot.sendChatAction(msg.chat.id, 'typing');
  const answer = await askAI(msg.text);
  bot.sendMessage(msg.chat.id, answer);
});

bot.on('polling_error', (error) => {
  console.error("Ошибка Telegram (polling):", error.message);
});

console.log("Бот успешно запущен.");
