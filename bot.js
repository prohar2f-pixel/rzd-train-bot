require('dotenv').config();

const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');
const axios = require('axios');

// Конфигурация
const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  RZD_LOGIN: process.env.RZD_LOGIN,
  RZD_PASSWORD: process.env.RZD_PASSWORD,
  GRANDTRAIN_LOGIN: process.env.GRANDTRAIN_LOGIN,
  GRANDTRAIN_PASSWORD: process.env.GRANDTRAIN_PASSWORD,

  // Параметры поиска
  SEARCH: {
    fromCode: '2000000',  // Москва
    toCode: '2078001',    // Симферополь
    dates: ['2026-07-13', '2026-07-14', '2026-07-15'],
    trainType: 'ПЛАЦКАРТ'
  },

  CHECK_INTERVAL: '*/10 * * * *', // Каждые 10 минут
  RZD_API_URL: 'https://api.rzd.ru/api/v1',
  RZD_SITE_URL: 'https://www.rzd.ru',
  GRANDTRAIN_URL: 'https://grandtrain.ru'
};

// Проверки конфига
if (!CONFIG.TELEGRAM_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('❌ ОШИБКА: Не установлены TELEGRAM_TOKEN и TELEGRAM_CHAT_ID');
  console.error('Создайте файл .env и заполните необходимые значения');
  process.exit(1);
}

const bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, { polling: false });
let browser;
let foundTickets = new Set();
let isRunning = false;

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
    console.log(`[${new Date().toLocaleString()}] 🔍 Проверяю билеты...`);

    // Сначала пробуем grandtrain.ru (более надёжный)
    if (CONFIG.GRANDTRAIN_LOGIN && CONFIG.GRANDTRAIN_PASSWORD) {
      console.log('  → Проверяю grandtrain.ru...');
      await searchViaGrandtrain();
    } else {
      // Если нет логина, ищем через РЖД
      console.log('  → Проверяю РЖД...');
      await searchViaAPI();
    }
  } catch (error) {
    console.error('❌ Ошибка при поиске:', error.message);
  }
}

async function searchViaGrandtrain() {
  try {
    const browserInstance = await initBrowser();
    const page = await browserInstance.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1280, height: 720 });

    // Логин
    console.log('  🔐 Авторизуюсь на grandtrain.ru...');
    await page.goto(`${CONFIG.GRANDTRAIN_URL}/login`, { waitUntil: 'networkidle2', timeout: 30000 });

    await page.type('input[type="email"]', CONFIG.GRANDTRAIN_LOGIN, { delay: 50 });
    await page.type('input[type="password"]', CONFIG.GRANDTRAIN_PASSWORD, { delay: 50 });
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

    // Ищем билеты на каждую дату
    for (const date of CONFIG.SEARCH.dates) {
      const [year, month, day] = date.split('-');
      const dateStr = `${day}.${month}.${year}`;

      console.log(`  📅 Ищу билеты на ${dateStr}...`);

      const searchUrl = `${CONFIG.GRANDTRAIN_URL}/search/${CONFIG.SEARCH.fromCode}-${CONFIG.SEARCH.toCode}/${dateStr}`;
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

      // Ищем плацкарты
      const trains = await page.evaluate(() => {
        const results = [];
        document.querySelectorAll('[class*="train-item"], [class*="train-card"]').forEach(el => {
          const trainData = {
            number: el.getAttribute('data-number') || el.querySelector('[class*="number"]')?.textContent?.trim(),
            departure: el.querySelector('[class*="departure"]')?.textContent?.trim(),
            arrival: el.querySelector('[class*="arrival"]')?.textContent?.trim(),
            type: el.textContent,
            element: el
          };

          if (trainData.number && trainData.type.includes('плацкарт')) {
            results.push(trainData);
          }
        });
        return results;
      });

      console.log(`    ✓ Найдено поездов: ${trains.length}`);

      for (const train of trains) {
        await checkGrandtrainSeats(page, train, dateStr);
      }
    }

    await page.close();
  } catch (error) {
    console.error(`  ❌ Ошибка grandtrain: ${error.message}`);
    console.log('  📍 Переключаюсь на РЖД...');
    await searchViaAPI();
  }
}

async function checkGrandtrainSeats(page, train, date) {
  try {
    await page.click(`[data-number="${train.number}"]`);
    await page.waitForSelector('[class*="seat"], [class*="place"]', { timeout: 5000 });

    const seatsInfo = await page.evaluate(() => {
      const seats = [];
      document.querySelectorAll('[class*="plackart"] [class*="seat"], [class*="place"]').forEach(el => {
        if (!el.classList.toString().includes('sold') && !el.classList.toString().includes('unavailable')) {
          seats.push({
            number: el.getAttribute('data-number') || el.textContent?.trim(),
            type: el.getAttribute('data-type') || 'unknown'
          });
        }
      });
      return seats;
    });

    if (seatsInfo.length >= 3) {
      const ticketKey = `${train.number}-${date}`;
      if (!foundTickets.has(ticketKey)) {
        foundTickets.add(ticketKey);

        await notifyAboutTickets({
          number: train.number,
          departure: train.departure,
          arrival: train.arrival,
          date: date,
          seatsCount: seatsInfo.length,
          source: 'grandtrain'
        });
      }
    }
  } catch (error) {
    console.log(`    ℹ️  Не удалось проверить поезд ${train.number}`);
  }
}

async function searchViaAPI() {
  try {
    console.log(`  🌐 Проверяю РЖД через API...`);

    for (const date of CONFIG.SEARCH.dates) {
      try {
        const response = await axios.get(`${CONFIG.RZD_API_URL}/train_schedule`, {
          params: {
            from: CONFIG.SEARCH.fromCode,
            to: CONFIG.SEARCH.toCode,
            date: date
          },
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });

        if (response.data && response.data.trains) {
          await processTrains(response.data.trains, date);
        }
      } catch (error) {
        console.log(`    ⚠️  API недоступен для ${date}, переключаюсь на парсинг...`);
        await searchViaBrowser(date);
      }
    }
  } catch (error) {
    console.error('❌ Ошибка при поиске через API:', error.message);
  }
}

async function searchViaBrowser(date) {
  try {
    console.log(`📱 Парсю сайт РЖД для ${date}...`);

    const browserInstance = await initBrowser();
    const page = await browserInstance.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

    // Идём на сайт РЖД с параметрами поиска
    const searchUrl = `${CONFIG.RZD_SITE_URL}/?tfl=true&from=${CONFIG.SEARCH.fromCode}&to=${CONFIG.SEARCH.toCode}&date=${date.split('-').reverse().join('.')}`;

    console.log(`  → ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Ждём загрузки результатов
    await page.waitForSelector('[class*="train"]', { timeout: 10000 });

    // Парсим поезда
    const trains = await page.evaluate(() => {
      const results = [];

      // Ищем блоки поездов
      document.querySelectorAll('[class*="train"]').forEach(el => {
        const trainInfo = {
          number: el.getAttribute('data-number') || el.textContent.match(/\d{3,4}/)?.[0],
          departure: el.querySelector('[class*="departure"]')?.textContent || '',
          arrival: el.querySelector('[class*="arrival"]')?.textContent || '',
          type: el.textContent,
          element: el
        };

        if (trainInfo.number) {
          results.push(trainInfo);
        }
      });

      return results;
    });

    console.log(`  ✓ Найдено поездов: ${trains.length}`);

    // Проверяем каждый поезд на плацкарт и места
    for (const train of trains) {
      if (train.type.includes('ПЛАЦКАРТ') || train.type.includes('плацкарт')) {
        await checkTrainSeats(page, train, date);
      }
    }

    await page.close();
  } catch (error) {
    console.error(`  ❌ Ошибка парсинга: ${error.message}`);
  }
}

async function checkTrainSeats(page, train, date) {
  try {
    // Кликаем на поезд
    await page.click(`[data-number="${train.number}"]`);
    await page.waitForSelector('[class*="seat"]', { timeout: 5000 });

    // Парсим места в плацкарте
    const seatsInfo = await page.evaluate(() => {
      const seats = [];
      document.querySelectorAll('[class*="plackart"] [class*="seat"]').forEach(el => {
        if (el.getAttribute('data-status')?.includes('available') ||
            el.classList.toString().includes('available')) {
          seats.push({
            number: el.getAttribute('data-number') || el.textContent,
            type: el.getAttribute('data-type') || 'unknown',
            price: el.getAttribute('data-price') || ''
          });
        }
      });
      return seats;
    });

    // Проверяем наличие нужных мест
    if (seatsInfo.length >= 3) {
      const ticketKey = `${train.number}-${date}`;
      if (!foundTickets.has(ticketKey)) {
        foundTickets.add(ticketKey);

        await notifyAboutTickets({
          number: train.number,
          departure: train.departure,
          arrival: train.arrival,
          date: date,
          seatsCount: seatsInfo.length,
          seats: seatsInfo.slice(0, 3)
        });
      }
    }
  } catch (error) {
    console.log(`  ℹ️  Не удалось проверить поезд ${train.number}`);
  }
}

async function processTrains(trains, date) {
  for (const train of trains) {
    if (train.type?.includes('ПЛАЦКАРТ') && train.seats?.available >= 3) {
      const ticketKey = `${train.number}-${date}`;

      if (!foundTickets.has(ticketKey)) {
        foundTickets.add(ticketKey);

        await notifyAboutTickets({
          number: train.number,
          departure: train.departure,
          arrival: train.arrival,
          date: date,
          seatsCount: train.seats.available,
          price: train.price
        });
      }
    }
  }
}

async function notifyAboutTickets(ticketInfo) {
  const sourceEmoji = ticketInfo.source === 'grandtrain' ? '🎫' : '🚆';
  const sourceUrl = ticketInfo.source === 'grandtrain' ? 'https://grandtrain.ru' : 'https://www.rzd.ru';

  let message = `
🎉 *НАЙДЕНЫ БИЛЕТЫ НА ПОЕЗД!*

${sourceEmoji} Источник: ${ticketInfo.source === 'grandtrain' ? 'GrandTrain.ru' : 'РЖД'}

🚂 Номер поезда: \`${ticketInfo.number}\`
📅 Дата: ${ticketInfo.date}
⏰ Отправление: ${ticketInfo.departure}
🏁 Прибытие: ${ticketInfo.arrival}

💺 Мест в наличии: ${ticketInfo.seatsCount}
${ticketInfo.price ? `💰 Цена: ${ticketInfo.price}` : ''}

⚡ *СРОЧНО!* Забронируйте билеты прямо сейчас!
👉 ${sourceUrl}
  `;

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log(`✅ Уведомление отправлено: поезд ${ticketInfo.number}`);
  } catch (error) {
    console.error('❌ Ошибка отправки в Telegram:', error.message);
  }
}

async function startSearching() {
  if (isRunning) {
    console.log('⚠️  Поиск уже идёт...');
    return;
  }

  isRunning = true;

  try {
    // Первая проверка сразу
    await searchTickets();

    // Потом по расписанию
    schedule.scheduleJob(CONFIG.CHECK_INTERVAL, async () => {
      await searchTickets();
    });
  } finally {
    isRunning = false;
  }
}

async function startBot() {
  console.log('\n╔════════════════════════════════════╗');
  console.log('║  🚂 РЖД БОТ - ПОИСК БИЛЕТОВ      ║');
  console.log('╚════════════════════════════════════╝\n');

  console.log('📋 Параметры поиска:');
  console.log(`  • Маршрут: Москва (${CONFIG.SEARCH.fromCode}) → Симферополь (${CONFIG.SEARCH.toCode})`);
  console.log(`  • Даты: ${CONFIG.SEARCH.dates.join(', ')}`);
  console.log(`  • Тип: ${CONFIG.SEARCH.trainType}`);
  console.log(`  • Интервал проверки: 10 минут\n`);

  console.log('⏱️  Бот запущен. Проверяю билеты...\n');

  // Отправляем приветствие в Telegram
  try {
    await bot.sendMessage(
      CONFIG.TELEGRAM_CHAT_ID,
      '✅ РЖД-бот запущен!\n\n🔍 Ищу билеты на Москва → Симферополь\n📅 13-15 июля 2026\n\n⏰ Проверка каждые 10 минут'
    );
  } catch (error) {
    console.error('⚠️  Не удалось отправить приветствие:', error.message);
  }

  await startSearching();

  // Graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n\n🛑 Завершаю работу...');

    try {
      await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '🛑 Бот остановлен.');
    } catch (e) {}

    if (browser) {
      await browser.close();
    }

    process.exit(0);
  });
}

// Запуск
startBot().catch(error => {
  console.error('💥 Критическая ошибка:', error);
  process.exit(1);
});
