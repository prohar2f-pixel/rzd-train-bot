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
    console.log(`[${new Date().toLocaleString()}] 🔍 Проверяю билеты на grandtrain.ru...`);

    const browserInstance = await initBrowser();
    const page = await browserInstance.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    for (const date of CONFIG.SEARCH.dates) {
      try {
        const searchUrl = `${CONFIG.GRANDTRAIN_URL}/search/${CONFIG.SEARCH.route}/${date}`;
        console.log(`  📅 ${date}`);

        // Загружаем страницу
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Ждём загрузки динамического контента
        await page.waitForTimeout(3000);

        // Извлекаем информацию со страницы
        const pageInfo = await page.evaluate(() => {
          const body = document.body;
          const allText = body.innerText || body.textContent || '';

          // Ищем информацию о поездах
          const lines = allText.split('\n');

          // Проверяем наличие ключевых слов
          const hasPlackart = allText.toLowerCase().includes('плацкарт');
          const hasTrains = allText.match(/\d{3,4}/g) !== null;
          const hasTimes = allText.match(/\d{1,2}:\d{2}/g) !== null;

          // Ищем строки с информацией о номерах поездов и временах
          const trainLines = lines.filter(line => {
            const hasNumber = /\d{3,4}/.test(line);
            const hasTime = /\d{1,2}:\d{2}/.test(line);
            return hasNumber || hasTime;
          }).slice(0, 20); // Первые 20 строк с номерами/временами

          return {
            hasPlackart: hasPlackart,
            hasTrains: hasTrains,
            hasTimes: hasTimes,
            textLength: allText.length,
            trainLines: trainLines,
            pageTitle: document.title,
            hasContent: allText.length > 1000
          };
        });

        // Выводим отладку
        console.log(`    ℹ️  Плацкарт найден: ${pageInfo.hasPlackart}`);
        console.log(`    ℹ️  Номера поездов найдены: ${pageInfo.hasTrains}`);
        console.log(`    ℹ️  Времена найдены: ${pageInfo.hasTimes}`);
        console.log(`    ℹ️  Размер страницы: ${pageInfo.textLength} символов`);
        console.log(`    ℹ️  Содержимое загружено: ${pageInfo.hasContent}`);

        if (pageInfo.trainLines.length > 0) {
          console.log(`    📝 Найденные строки:`);
          pageInfo.trainLines.forEach(line => {
            if (line.trim()) {
              console.log(`       ${line.trim().substring(0, 80)}`);
            }
          });
        }

        // Если нашли плацкарты и номера поездов - отправляем уведомление
        if (pageInfo.hasPlackart && pageInfo.hasTrains) {
          // Ищем номера поездов в тексте
          const trainMatches = pageInfo.trainLines.join(' ').match(/\d{3,4}/g) || [];
          const uniqueTrains = [...new Set(trainMatches)].slice(0, 5);

          if (uniqueTrains.length > 0) {
            const ticketKey = `${date}-${uniqueTrains.join(',')}`;

            if (!foundTickets.has(ticketKey)) {
              foundTickets.add(ticketKey);

              await notifyAboutTickets({
                date: date,
                trains: uniqueTrains,
                url: searchUrl
              });
            }
          }
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

👉 ${ticketInfo.url}
  `;

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log(`    ✅ Уведомление отправлено в Telegram`);
  } catch (error) {
    console.error('    ❌ Ошибка отправки:', error.message);
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

  // Приветствие в Telegram
  try {
    await bot.sendMessage(
      CONFIG.TELEGRAM_CHAT_ID,
      '✅ РЖД-бот запущен!\n\n🔍 Ищу билеты на Москва → Симферополь\n📅 13-15 июля 2026\n💺 Плацкарт\n\n⏰ Проверка каждые 10 минут'
    );
    console.log('✓ Приветствие отправлено в Telegram\n');
  } catch (error) {
    console.error('⚠️  Ошибка приветствия:', error.message);
  }

  // Первая проверка
  await searchTickets();

  // По расписанию
  console.log('✓ Следующая проверка через 10 минут...\n');
  schedule.scheduleJob(CONFIG.CHECK_INTERVAL, async () => {
    await searchTickets();
  });

  // Graceful shutdown
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
