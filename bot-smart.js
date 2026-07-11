require('dotenv').config();

const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');

const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  SEARCH: {
    dates: ['13.07.2026', '14.07.2026', '15.07.2026'],
    route: '2000000-2078001'
  },
  CHECK_INTERVAL: '*/10 * * * *',
  RZD_URL: 'https://www.rzd.ru'
};

if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('❌ ОШИБКА: TELEGRAM_TOKEN и TELEGRAM_CHAT_ID обязательны');
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
        const [day, month, year] = date.split('.');
        console.log(`\n  📅 ${date}`);

        const searchUrl = `${CONFIG.RZD_URL}/?tfl=true&from=2000000&to=2078001&date=${date.split('-').reverse().join('.')}`;

        console.log(`    ⏳ Загружаю страницу РЖД...`);
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

        // Ждём загрузки результатов
        await page.waitForTimeout(3000);

        // Получаем все текстовые данные со страницы
        const pageData = await page.evaluate(() => {
          const text = document.body.innerText || '';
          const html = document.body.innerHTML || '';

          // Ищем информацию о поездах в HTML и тексте
          return {
            text: text,
            htmlLength: html.length,
            hasPlackart: text.toLowerCase().includes('плацкарт'),
            hasTrains: /\d{3,4}/.test(text),
            hasPrices: /\d{1,2}\s*\d{3}/.test(text),
            textSnippet: text.substring(0, 500)
          };
        });

        console.log(`    ✓ Страница загружена (${pageData.htmlLength} символов HTML)`);
        console.log(`    ✓ Плацкарт на странице: ${pageData.hasPlackart ? '✅ ДА' : '❌ НЕТ'}`);
        console.log(`    ✓ Поезда найдены: ${pageData.hasTrains ? '✅ ДА' : '❌ НЕТ'}`);

        // Если видим плацкарты и поезда - это хорошо
        if (pageData.hasPlackart && pageData.hasTrains) {
          console.log(`    🎉 НАЙДЕНО: Плацкарты есть на странице!`);

          const ticketKey = `${date}`;
          if (!foundTickets.has(ticketKey)) {
            foundTickets.add(ticketKey);

            await notifyAboutTickets({
              date: date,
              url: searchUrl
            });
          }
        } else if (!pageData.hasPlackart) {
          console.log(`    ℹ️  Плацкартов нет на эту дату`);
        } else {
          console.log(`    ⚠️  Страница загрузилась но контент не виден (может потребоваться JavaScript)`);
        }

      } catch (error) {
        console.log(`    ❌ Ошибка для даты ${date}: ${error.message}`);
      }
    }

    await page.close();
  } catch (error) {
    console.error('❌ Критическая ошибка:', error.message);
  }
}

async function notifyAboutTickets(ticketInfo) {
  const message = `
🎉 *НАЙДЕНЫ БИЛЕТЫ НА ПЛАЦКАРТ!*

📅 Дата: ${ticketInfo.date}

🔗 Открыть РЖД:
${ticketInfo.url}

⚡ *СРОЧНО! Забронируйте билеты прямо сейчас!*
  `;

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log(`    ✅ Уведомление отправлено в Telegram!`);
  } catch (error) {
    console.error(`    ❌ Ошибка Telegram: ${error.message}`);
  }
}

async function startBot() {
  console.log('\n╔════════════════════════════════════╗');
  console.log('║  🚂 РЖД БОТ - SMART PARSER       ║');
  console.log('╚════════════════════════════════════╝\n');

  console.log('📋 Параметры:');
  console.log(`  🚂 Маршрут: Москва → Симферополь`);
  console.log(`  📅 Даты: ${CONFIG.SEARCH.dates.join(', ')}`);
  console.log(`  💺 Ищем: ПЛАЦКАРТ`);
  console.log(`  ⏰ Проверка: каждые 10 минут`);
  console.log(`  🔌 Используем: Браузер Puppeteer + парсинг РЖД\n`);

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '✅ РЖД-бот запущен! (Smart Parser)');
  } catch (error) {
    console.error('⚠️  Ошибка приветствия');
  }

  // Первая проверка
  await searchTickets();

  // По расписанию
  console.log('\n✓ Следующая проверка через 10 минут...');
  schedule.scheduleJob(CONFIG.CHECK_INTERVAL, async () => {
    await searchTickets();
  });

  process.on('SIGINT', async () => {
    console.log('\n🛑 Завершаю...');
    if (browser) await browser.close();
    process.exit(0);
  });
}

startBot().catch(error => {
  console.error('💥 Ошибка:', error);
  process.exit(1);
});
