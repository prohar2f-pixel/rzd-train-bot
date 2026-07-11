require('dotenv').config();

const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');

const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  SEARCH: {
    dates: ['13.07.2026', '14.07.2026', '15.07.2026'],
  },
  CHECK_INTERVAL: '*/10 * * * *',
  RZD_URL: 'https://www.rzd.ru'
};

if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('❌ ОШИБКА: Не установлены токены');
  process.exit(1);
}

const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });
let browser;
let foundTickets = new Set();

async function initBrowser() {
  if (!browser) {
    console.log('🚀 Запускаю браузер...');
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }
  return browser;
}

async function searchTickets() {
  try {
    console.log(`\n[${new Date().toLocaleString()}] 🔍 ПРОВЕРКА БИЛЕТОВ РЖД`);

    const browserInstance = await initBrowser();
    const page = await browserInstance.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    for (const date of CONFIG.SEARCH.dates) {
      try {
        console.log(`  📅 ${date}`);

        const dateFormatted = date.split('-').reverse().join('.');
        const searchUrl = `${CONFIG.RZD_URL}/?tfl=true&from=2000000&to=2078001&date=${dateFormatted}`;

        console.log(`    ⏳ Загружаю РЖД...`);
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForTimeout(2000);

        // Получаем весь текст со страницы
        const pageText = await page.evaluate(() => {
          return document.body.innerText || '';
        });

        // Ищем плацкарты
        const hasPlackart = pageText.toLowerCase().includes('плацкарт');
        const hasPrices = /\d{1,2}\s*\d{3}[,\.]\d{2}/.test(pageText);
        const hasRub = pageText.includes('₽') || pageText.includes('руб');

        console.log(`    ${hasPlackart ? '✓' : '✗'} Плацкарт: ${hasPlackart ? 'найден' : 'нет'}`);
        console.log(`    ${hasPrices || hasRub ? '✓' : '✗'} Цены: ${hasPrices || hasRub ? 'видны' : 'нет'}`);

        if (hasPlackart && (hasPrices || hasRub)) {
          console.log(`    🎉 НАЙДЕНЫ БИЛЕТЫ НА ПЛАЦКАРТ!`);

          const ticketKey = date;
          if (!foundTickets.has(ticketKey)) {
            foundTickets.add(ticketKey);

            await notifyAboutTickets({
              date: dateFormatted,
              url: searchUrl
            });
          }
        } else if (!hasPlackart) {
          console.log(`    ℹ️  Плацкартов нет`);
        }

      } catch (error) {
        console.log(`    ❌ Ошибка: ${error.message}`);
      }
    }

    await page.close();
  } catch (error) {
    console.error('❌ Ошибка:', error.message);
  }
}

async function notifyAboutTickets(info) {
  const message = `
🎉 *НАЙДЕНЫ БИЛЕТЫ НА ПЛАЦКАРТ!*

📅 Дата: ${info.date}

🔗 Открыть РЖД:
${info.url}

⚡ *СРОЧНО! Забронируйте прямо сейчас!*
  `;

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log(`    ✅ Уведомление отправлено!`);
  } catch (error) {
    console.error(`    ❌ Ошибка Telegram`);
  }
}

async function startBot() {
  console.log('\n╔════════════════════════════════════╗');
  console.log('║  🚂 РЖД БОТ v3                   ║');
  console.log('╚════════════════════════════════════╝\n');

  console.log('📋 Параметры:');
  console.log(`  📅 Даты: ${CONFIG.SEARCH.dates.join(', ')}`);
  console.log(`  💺 Ищем: ПЛАЦКАРТ`);
  console.log(`  ⏰ Проверка: каждые 10 минут\n`);

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '✅ РЖД-бот запущен!');
  } catch (e) {}

  await searchTickets();

  console.log('✓ Следующая проверка через 10 минут...');
  schedule.scheduleJob(CONFIG.CHECK_INTERVAL, await searchTickets);

  process.on('SIGINT', async () => {
    console.log('\n🛑 Завершаю...');
    if (browser) await browser.close();
    process.exit(0);
  });
}

startBot().catch(console.error);
