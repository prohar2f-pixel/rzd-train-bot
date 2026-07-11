require('dotenv').config();

const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');

const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  SEARCH: {
    fromCode: '2000000', // Москва (любой вокзал)
    toCode: '2078001',   // Симферополь
    dates: ['13.07.2026', '14.07.2026', '15.07.2026'],
  },
  CHECK_INTERVAL: '*/10 * * * *',
  BASE_URL: 'https://grandtrain.ru'
};

if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('❌ ОШИБКА: Не установлены TELEGRAM_TOKEN и TELEGRAM_CHAT_ID');
  process.exit(1);
}

const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });
let browser;
let lastNotified = new Map(); // ключ -> timestamp, чтобы не спамить одним и тем же

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

// Разбивает текст страницы на блоки по поездам и ищет плацкарт с ценой/местами
function parsePlackartTrains(pageText) {
  const found = [];

  // Каждый блок поезда начинается со времени отправления вида "23:55"
  const blocks = pageText.split(/(?=^\d{2}:\d{2}$)/m).filter(b => /№\S+/.test(b));

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);

    const departureTime = lines[0];
    const trainNumberMatch = block.match(/№(\S+)/);
    const trainNumber = trainNumberMatch ? trainNumberMatch[1] : '?';
    const routeMatch = block.match(/Москва\s*—\s*[А-Яа-яёЁ\s]+/);
    const route = routeMatch ? routeMatch[0].trim() : '';

    // Ищем строку с классом "Плац" или "Плацкарт"
    const plackartIdx = lines.findIndex(l => /^Плац(карт)?$/i.test(l));

    if (plackartIdx !== -1) {
      const seatsLine = lines[plackartIdx + 1] || '';
      const priceLine = lines[plackartIdx + 2] || '';

      const priceMatch = priceLine.match(/от\s*([\d\s]+,\d+)\s*₽/);
      const isWaitlist = seatsLine.includes('Лист ожидания') || priceLine.includes('Лист ожидания');

      if (!isWaitlist && priceMatch) {
        found.push({
          departureTime,
          trainNumber,
          route,
          seats: seatsLine,
          price: priceMatch[1].trim() + ' ₽'
        });
      }
    }
  }

  return found;
}

async function searchTickets() {
  try {
    console.log(`\n[${new Date().toLocaleString()}] 🔍 ПРОВЕРКА БИЛЕТОВ (grandtrain.ru)`);

    const browserInstance = await initBrowser();

    for (const date of CONFIG.SEARCH.dates) {
      const page = await browserInstance.newPage();
      try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
        await page.setViewport({ width: 1280, height: 900 });

        const searchUrl = `${CONFIG.BASE_URL}/search/${CONFIG.SEARCH.fromCode}-${CONFIG.SEARCH.toCode}/${date}/`;
        console.log(`  📅 ${date}`);
        console.log(`    ⏳ Загружаю (это SPA, жду ~18 сек)...`);

        try {
          await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (navError) {
          // SPA может сделать повторную навигацию/редирект — это не критично
        }

        // Ждём пока прогрузится реальный список поездов (а не просто скелет страницы)
        await page.waitForFunction(
          () => document.body.innerText.includes('Выберите рейс') || document.body.innerText.length > 3000,
          { timeout: 25000 }
        ).catch(() => console.log('    ⚠️  Не дождались явного признака загрузки, парсю как есть'));

        await page.waitForTimeout(3000);

        const pageText = await page.evaluate(() => document.body.innerText).catch(() => '');

        if (!pageText || pageText.length < 500) {
          console.log(`    ⚠️  Страница не загрузилась (${pageText.length} символов)`);
          continue;
        }

        const trains = parsePlackartTrains(pageText);
        console.log(`    ✓ Плацкарт найден в ${trains.length} поезд(ах)`);

        for (const train of trains) {
          console.log(`      🎉 №${train.trainNumber} ${train.route} | ${train.departureTime} | ${train.seats} | ${train.price}`);

          const key = `${date}-${train.trainNumber}-${train.seats}`;
          const now = Date.now();
          const lastTime = lastNotified.get(key);

          // Не уведомляем повторно о том же самом (та же дата+поезд+места) чаще раза в час
          if (!lastTime || now - lastTime > 60 * 60 * 1000) {
            lastNotified.set(key, now);
            await notifyAboutTickets({
              date,
              url: searchUrl,
              ...train
            });
          }
        }

      } catch (error) {
        console.log(`    ❌ Ошибка [${error.name}]: ${error.message}`);
      } finally {
        await page.close();
      }
    }

  } catch (error) {
    console.error('❌ Критическая ошибка:', error.message);
  }
}

async function notifyAboutTickets(info) {
  const message = `
🎉 *НАЙДЕНЫ БИЛЕТЫ НА ПЛАЦКАРТ!*

📅 Дата: ${info.date}
🚂 Поезд №${info.trainNumber} (${info.route})
⏰ Отправление: ${info.departureTime}
💺 Места: ${info.seats}
💰 Цена: от ${info.price}

🔗 Открыть и забронировать:
${info.url}

⚡ *СРОЧНО! Места разлетаются за минуты!*
  `;

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log(`      ✅ Уведомление отправлено в Telegram!`);
  } catch (error) {
    console.error(`      ❌ Ошибка Telegram: ${error.message}`);
  }
}

async function startBot() {
  console.log('\n╔════════════════════════════════════╗');
  console.log('║  🚂 РЖД БОТ v4 - grandtrain.ru    ║');
  console.log('╚════════════════════════════════════╝\n');

  console.log('📋 Параметры:');
  console.log(`  🚂 Маршрут: Москва → Симферополь (включая транзитные поезда)`);
  console.log(`  📅 Даты: ${CONFIG.SEARCH.dates.join(', ')}`);
  console.log(`  💺 Ищем: ПЛАЦКАРТ`);
  console.log(`  ⏰ Проверка: каждые 10 минут\n`);

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '✅ РЖД-бот v4 запущен! (grandtrain.ru, с транзитными поездами)');
  } catch (error) {
    console.error('⚠️  Ошибка приветствия:', error.message);
  }

  await searchTickets();

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
