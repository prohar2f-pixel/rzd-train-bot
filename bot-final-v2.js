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
    console.log(`\n[${new Date().toLocaleString()}] 🔍 ПОИСК БИЛЕТОВ РЖД`);

    const browserInstance = await initBrowser();
    const page = await browserInstance.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    for (const date of CONFIG.SEARCH.dates) {
      try {
        console.log(`\n  📅 ${date}`);

        const dateFormatted = date.split('-').reverse().join('.');
        const searchUrl = `${CONFIG.RZD_URL}/?tfl=true&from=2000000&to=2078001&date=${dateFormatted}`;

        console.log(`    ⏳ Загружаю поезда...`);
        await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForTimeout(2000);

        // Получаем все видимые поезда
        const trains = await page.evaluate(() => {
          const results = [];

          // Ищем элементы с информацией о поездах
          const trainElements = document.querySelectorAll(
            '[class*="train"], [class*="route"], [role="button"][class*="ticket"], li[class*="train"]'
          );

          trainElements.forEach((el, idx) => {
            const text = el.textContent || '';
            if (text.match(/\d{3,4}/) || text.includes('Москва') || text.includes('Симферополь')) {
              results.push({
                index: idx,
                text: text.substring(0, 200),
                element: el
              });
            }
          });

          return results.slice(0, 20); // Берём первые 20
        });

        console.log(`    ✓ Найдено поездов на странице: ${trains.length}`);

        let plackartFound = false;

        // Кликаем на каждый поезд и проверяем вагоны
        for (let i = 0; i < Math.min(trains.length, 15); i++) {
          try {
            // Ищем клик-элемент
            const clickable = await page.evaluate((idx) => {
              const trainElements = document.querySelectorAll('[class*="train"], [role="button"]');
              if (trainElements[idx]) {
                return {
                  found: true,
                  text: trainElements[idx].textContent?.substring(0, 100)
                };
              }
              return { found: false };
            }, i);

            if (!clickable.found) continue;

            // Кликаем на поезд
            const trainElements = await page.$$('[class*="train"], [role="button"]');
            if (trainElements[i]) {
              await trainElements[i].click();
              await page.waitForTimeout(1500);

              // Ищем информацию о плацкартах в развёрнутом поезде
              const plackartInfo = await page.evaluate(() => {
                const text = document.body.innerText || '';
                const hasPlackart = text.toLowerCase().includes('плацкарт');
                const hasFreeSeats = text.match(/\d+\s*(место|мест|свободно)/i) !== null;

                // Ищем цены (индикатор наличия)
                const prices = text.match(/\d{1,2}\s*\d{3}[,\.]\d{2}\s*₽/g) || [];

                return {
                  hasPlackart: hasPlackart,
                  hasFreeSeats: hasFreeSeats,
                  pricesFound: prices.length > 0,
                  textSnippet: text.substring(0, 300)
                };
              });

              if (plackartInfo.hasPlackart && plackartInfo.pricesFound) {
                console.log(`    🎉 ПЛАЦКАРТ НАЙДЕН в поезде ${i + 1}!`);
                plackartFound = true;

                const ticketKey = `${date}-${i}`;
                if (!foundTickets.has(ticketKey)) {
                  foundTickets.add(ticketKey);

                  await notifyAboutTickets({
                    date: dateFormatted,
                    trainNumber: i + 1,
                    url: searchUrl
                  });
                  break; // Нашли, переходим к следующей дате
                }
              }

              // Кликаем обратно или закрываем
              await page.goBack({ waitUntil: 'networkidle2' }).catch(() => {});
              await page.waitForTimeout(1000);
            }

          } catch (error) {
            console.log(`    ℹ️  Ошибка проверки поезда ${i + 1}`);
          }
        }

        if (!plackartFound) {
          console.log(`    ℹ️  Плацкартов не найдено на эту дату`);
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
🚂 Поезд: ${ticketInfo.trainNumber}

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
  console.log('║  🚂 РЖД БОТ - FINAL v2           ║');
  console.log('║  (Кликает на поезда + парсит)    ║');
  console.log('╚════════════════════════════════════╝\n');

  console.log('📋 Параметры:');
  console.log(`  📅 Даты: ${CONFIG.SEARCH.dates.join(', ')}`);
  console.log(`  💺 Ищем: ПЛАЦКАРТ`);
  console.log(`  ⏰ Проверка: каждые 10 минут`);
  console.log(`  🔌 Метод: Puppeteer + клики на поезда\n`);

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '✅ РЖД-бот запущен! (Final v2 - кликает на поезда)');
  } catch (error) {
    console.error('⚠️  Ошибка приветствия');
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
