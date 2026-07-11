require('dotenv').config();

const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');

// Конфигурация
const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  // Параметры поиска
  SEARCH: {
    dates: ['13.07.2026', '14.07.2026', '15.07.2026'],
    route: '2000000-2078001' // Москва-Симферополь
  },

  CHECK_INTERVAL: '*/10 * * * *', // Каждые 10 минут
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

    // Ищем билеты на каждую дату
    for (const date of CONFIG.SEARCH.dates) {
      try {
        const searchUrl = `${CONFIG.GRANDTRAIN_URL}/search/${CONFIG.SEARCH.route}/${date}`;
        console.log(`  📅 ${date}: ${searchUrl}`);

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Даём странице время загрузиться
        await page.waitForTimeout(2000);

        // Ищем информацию о поездах прямо на странице
        const trains = await page.evaluate(() => {
          const results = [];

          // Пробуем разные селекторы для поездов
          const trainElements = document.querySelectorAll(
            '[class*="train"], [class*="route"], [class*="item"], article, [role="button"]'
          );

          console.log(`Найдено элементов: ${trainElements.length}`);

          trainElements.forEach((el, idx) => {
            const text = el.textContent || '';

            // Ищем ключевые слова: номер поезда, время, плацкарт
            if (text.match(/\d{3,4}/) && (text.includes('плацкарт') || text.includes('Плацкарт'))) {
              const trainNumber = text.match(/\d{3,4}/)?.[0];
              const departure = text.match(/(\d{1,2}:\d{2})/)?.[0];

              if (trainNumber && departure) {
                results.push({
                  number: trainNumber,
                  departure: departure,
                  text: text.substring(0, 100),
                  hasPlackart: true
                });
              }
            }
          });

          return results;
        });

        console.log(`    ✓ Найдено поездов с плацкартом: ${trains.length}`);

        // Проверяем каждый поезд на наличие мест
        for (const train of trains) {
          await checkTrainSeats(page, train, date);
        }
      } catch (error) {
        console.log(`  ⚠️  Ошибка для даты ${date}: ${error.message}`);
      }
    }

    await page.close();
  } catch (error) {
    console.error('❌ Критическая ошибка при поиске:', error.message);
  }
}

async function checkTrainSeats(page, train, date) {
  try {
    // Пробуем найти и кликнуть на элемент с информацией о поезде
    const hasSeats = await page.evaluate((trainNum) => {
      // Ищем текст который содержит номер поезда и информацию о местах
      const allText = document.body.innerText;
      const regex = new RegExp(trainNum + '.*?(?:мест|место|свободно|доступно)', 'i');

      if (regex.test(allText)) {
        const match = allText.match(regex);
        return match ? match[0] : true;
      }
      return false;
    }, train.number);

    if (hasSeats) {
      const ticketKey = `${train.number}-${date}`;

      if (!foundTickets.has(ticketKey)) {
        foundTickets.add(ticketKey);
        console.log(`    ✅ НАЙДЕНЫ БИЛЕТЫ: поезд ${train.number}`);

        await notifyAboutTickets({
          number: train.number,
          departure: train.departure,
          date: date
        });
      }
    }
  } catch (error) {
    console.log(`    ℹ️  Не удалось проверить поезд ${train.number}`);
  }
}

async function notifyAboutTickets(ticketInfo) {
  const message = `
🎉 *НАЙДЕНЫ БИЛЕТЫ НА ПОЕЗД!*

🚂 Номер поезда: \`${ticketInfo.number}\`
📅 Дата: ${ticketInfo.date}
⏰ Отправление: ${ticketInfo.departure}

⚡ *СРОЧНО! Переходите на сайт и бронируйте!*
👉 https://grandtrain.ru/search/2000000-2078001/${ticketInfo.date}
  `;

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log(`✅ Уведомление отправлено в Telegram`);
  } catch (error) {
    console.error('❌ Ошибка отправки в Telegram:', error.message);
    console.error('   Проверьте TELEGRAM_CHAT_ID в файле .env');
  }
}

async function startBot() {
  console.log('\n╔════════════════════════════════════╗');
  console.log('║  🚂 РЖД БОТ - ПОИСК БИЛЕТОВ      ║');
  console.log('╚════════════════════════════════════╝\n');

  console.log('📋 Параметры поиска:');
  console.log(`  • Маршрут: Москва → Симферополь`);
  console.log(`  • Даты: ${CONFIG.SEARCH.dates.join(', ')}`);
  console.log(`  • Тип: ПЛАЦКАРТ`);
  console.log(`  • Интервал проверки: 10 минут\n`);

  console.log('⏱️  Бот запущен. Проверяю билеты...\n');

  // Отправляем приветствие в Telegram
  try {
    await bot.sendMessage(
      CONFIG.TELEGRAM_CHAT_ID,
      '✅ РЖД-бот запущен!\n\n🔍 Ищу билеты на Москва → Симферополь\n📅 13-15 июля 2026\n💺 Плацкарт\n\n⏰ Проверка каждые 10 минут'
    );
    console.log('✓ Приветствие отправлено в Telegram\n');
  } catch (error) {
    console.error('⚠️  Ошибка при отправке приветствия:', error.message);
    console.error('   Убедитесь что:');
    console.error('   1. Написали боту хоть какое-то сообщение');
    console.error('   2. Chat ID правильный в .env');
    console.error('   3. Добавили бота в нужный чат\n');
  }

  // Первая проверка сразу
  await searchTickets();

  // Потом по расписанию каждые 10 минут
  console.log('✓ Следующая проверка через 10 минут...\n');
  schedule.scheduleJob(CONFIG.CHECK_INTERVAL, async () => {
    await searchTickets();
  });

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
