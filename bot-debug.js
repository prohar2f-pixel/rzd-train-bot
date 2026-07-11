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
  GRANDTRAIN_URL: 'https://grandtrain.ru'
};

if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('❌ ОШИБКА: Не установлены TELEGRAM_TOKEN и TELEGRAM_CHAT_ID');
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
    console.log(`[${new Date().toLocaleString()}] 🔍 Проверяю билеты на grandtrain.ru...`);

    const browserInstance = await initBrowser();
    const page = await browserInstance.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1280, height: 720 });

    for (const date of CONFIG.SEARCH.dates) {
      try {
        const searchUrl = `${CONFIG.GRANDTRAIN_URL}/search/${CONFIG.SEARCH.route}/${date}`;
        console.log(`  📅 ${date}`);

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Ждём загрузки контента
        await page.waitForTimeout(3000);

        // Парсим всю информацию со страницы
        const pageData = await page.evaluate(() => {
          // Берём весь текст страницы
          const allText = document.body.innerText;

          // Ищем информацию о поездах
          const trains = [];

          // Ищем номера поездов (обычно это 3-4 цифры)
          const trainNumbers = new Set();
          const numberMatches = allText.match(/\b\d{3,4}\b/g) || [];
          numberMatches.forEach(num => trainNumbers.add(num));

          // Ищем время отправления (hh:mm формат)
          const departures = new Set();
          const timeMatches = allText.match(/(\d{1,2}):(\d{2})/g) || [];
          timeMatches.forEach(time => departures.add(time));

          // Ищем слово "плацкарт"
          const hasPlackart = allText.toLowerCase().includes('плацкарт');

          // Ищем слова о доступности мест
          const hasAvailability = allText.toLowerCase().match(/(место|мест|свободно|доступно)/i);

          return {
            trainNumbers: Array.from(trainNumbers),
            departures: Array.from(departures),
            hasPlackart: hasPlackart,
            hasAvailability: hasAvailability ? true : false,
            pageLength: allText.length,
            textSnippet: allText.substring(0, 500)
          };
        });

        console.log(`    ℹ️  Найдено номеров: ${pageData.trainNumbers.length}`);
        console.log(`    ℹ️  Найдено времён: ${pageData.departures.length}`);
        console.log(`    ℹ️  Плацкарт на странице: ${pageData.hasPlackart}`);
        console.log(`    ℹ️  Слова о доступности: ${pageData.hasAvailability}`);

        if (pageData.trainNumbers.length > 0) {
          console.log(`    ℹ️  Номера поездов: ${pageData.trainNumbers.join(', ')}`);
        }

        if (pageData.departures.length > 0) {
          console.log(`    ℹ️  Времена: ${pageData.departures.join(', ')}`);
        }

        if (pageData.pageLength < 500) {
          console.log(`    ⚠️  Страница мала (${pageData.pageLength} символов) - возможно ошибка загрузки`);
        }

        // Если нашли плацкарты и номера поездов - это хорошо
        if (pageData.hasPlackart && pageData.trainNumbers.length > 0) {
          await notifyAboutTickets({
            date: date,
            trains: pageData.trainNumbers.slice(0, 3),
            times: pageData.departures.slice(0, 3)
          });
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
🎉 *НАЙДЕНЫ БИЛЕТЫ!*

📅 Дата: ${ticketInfo.date}
🚂 Поезда: ${ticketInfo.trains.join(', ')}
⏰ Времена: ${ticketInfo.times.join(', ')}

👉 https://grandtrain.ru/search/2000000-2078001/${ticketInfo.date}
  `;

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log(`✅ Уведомление в Telegram!`);
  } catch (error) {
    console.error('❌ Ошибка Telegram:', error.message);
  }
}

async function startBot() {
  console.log('\n╔════════════════════════════════════╗');
  console.log('║  🚂 РЖД БОТ - РЕЖИМ ОТЛАДКИ      ║');
  console.log('╚════════════════════════════════════╝\n');

  console.log('⏱️  Бот запущен...\n');

  await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '✅ РЖД-бот запущен (режим отладки)');

  await searchTickets();

  console.log('\n✓ Следующая проверка через 10 минут...\n');
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
