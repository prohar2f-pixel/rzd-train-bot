require('dotenv').config();

const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');

const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  GRANDTRAIN_LOGIN: process.env.GRANDTRAIN_LOGIN,
  GRANDTRAIN_PASSWORD: process.env.GRANDTRAIN_PASSWORD,
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

async function loginToGrandTrain(page) {
  if (!CONFIG.GRANDTRAIN_LOGIN || !CONFIG.GRANDTRAIN_PASSWORD) {
    console.log('  ℹ️  Логин не установлен, ищу без авторизации');
    return false;
  }

  try {
    console.log('  🔐 Авторизация на GrandTrain...');
    await page.goto(`${CONFIG.GRANDTRAIN_URL}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000);

    // Ищем поле email и password
    const emailInputs = await page.$$('input[type="email"], input[name*="email"], input[placeholder*="Email"], input[placeholder*="email"]');
    const passwordInputs = await page.$$('input[type="password"], input[name*="password"], input[placeholder*="Password"], input[placeholder*="password"]');

    if (emailInputs.length > 0 && passwordInputs.length > 0) {
      await emailInputs[0].type(CONFIG.GRANDTRAIN_LOGIN, { delay: 50 });
      await passwordInputs[0].type(CONFIG.GRANDTRAIN_PASSWORD, { delay: 50 });

      // Ищем кнопку отправки
      const buttons = await page.$$('button');
      let submitted = false;

      for (const btn of buttons) {
        const text = await page.evaluate(el => el.textContent, btn);
        if (text.includes('вход') || text.includes('войти') || text.includes('login') || text.includes('Вход') || text.includes('Войти')) {
          await btn.click();
          submitted = true;
          break;
        }
      }

      if (submitted) {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        console.log('    ✓ Авторизация прошла');
        return true;
      }
    }

    console.log('    ⚠️  Не удалось авторизоваться');
    return false;
  } catch (error) {
    console.log(`    ⚠️  Ошибка авторизации: ${error.message}`);
    return false;
  }
}

async function searchTickets() {
  try {
    console.log(`\n[${new Date().toLocaleString()}] 🔍 ПРОВЕРКА БИЛЕТОВ`);

    const browserInstance = await initBrowser();
    const page = await browserInstance.newPage();

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    // Пробуем авторизоваться
    await loginToGrandTrain(page);

    for (const date of CONFIG.SEARCH.dates) {
      try {
        const searchUrl = `${CONFIG.GRANDTRAIN_URL}/search/${CONFIG.SEARCH.route}/${date}`;
        console.log(`\n  📅 ${date}`);

        await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForTimeout(2000);

        const pageInfo = await page.evaluate(() => {
          const text = (document.body.innerText || document.body.textContent || '').toLowerCase();
          const allText = document.body.innerText || document.body.textContent || '';

          return {
            hasPlackart: text.includes('плацкарт'),
            textLength: allText.length,
            snippet: allText.substring(0, 300)
          };
        });

        console.log(`    📊 Размер страницы: ${pageInfo.textLength} символов`);
        console.log(`    🚂 Плацкарт: ${pageInfo.hasPlackart ? '✓ ДА' : '✗ НЕТ'}`);

        if (pageInfo.textLength < 500) {
          console.log(`    ⚠️  Страница мала - возможно ошибка загрузки или требуется JS`);
        }

        if (pageInfo.hasPlackart && pageInfo.textLength > 1000) {
          console.log(`    ✅ НАЙДЕНО: Плацкарты есть на странице!`);

          const ticketKey = `${date}`;
          if (!foundTickets.has(ticketKey)) {
            foundTickets.add(ticketKey);

            await notifyAboutTickets({
              date: date,
              url: searchUrl
            });
          }
        }

      } catch (error) {
        console.log(`    ❌ Ошибка: ${error.message}`);
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

👉 ${ticketInfo.url}
  `;

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log(`    ✅ Уведомление отправлено!`);
  } catch (error) {
    console.error(`    ❌ Ошибка Telegram: ${error.message}`);
  }
}

async function startBot() {
  console.log('\n╔════════════════════════════════════╗');
  console.log('║  🚂 РЖД БОТ v2 - ПОИСК БИЛЕТОВ   ║');
  console.log('╚════════════════════════════════════╝\n');

  console.log('📋 Параметры:');
  console.log(`  🚂 Маршрут: Москва → Симферополь`);
  console.log(`  📅 Даты: ${CONFIG.SEARCH.dates.join(', ')}`);
  console.log(`  💺 Тип: ПЛАЦКАРТ`);
  console.log(`  ⏰ Проверка: каждые 10 минут\n`);

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '✅ Бот запущен!');
  } catch (error) {
    console.error('⚠️  Ошибка Telegram');
  }

  await searchTickets();

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
