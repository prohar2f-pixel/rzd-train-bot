require('dotenv').config();

const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');
const schedule = require('node-schedule');

process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT EXCEPTION (процесс продолжает жить):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('💥 UNHANDLED REJECTION (процесс продолжает жить):', reason);
});

const CONFIG = {
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  // Каждый маршрут проверяется отдельно на все даты.
  // Крымские станции, кроме Симферополя, тоже подходят — дальше автобусом/электричкой.
  ROUTES: [
    { fromCode: '2000000', toCode: '2078001', label: 'Москва → Симферополь' },
    { fromCode: '2000000', toCode: '2078750', label: 'Москва → Севастополь' },
    // С 10.06.2026 часть поездов ГСЭ идёт только до Керчи Южной, дальше — бесплатный автобус
    // от компании до Симферополя/Севастополя/Евпатории по номеру ж/д билета (талон оформляется отдельно, без доплаты)
    { fromCode: '2000000', toCode: '2078144', label: 'Москва → Керчь Южная (+бесплатный автобус до Симферополя)' },
    { fromCode: '2000000', toCode: '2078770', label: 'Москва → Евпатория-Курорт' },
    { fromCode: '2000000', toCode: '2078860', label: 'Москва → Саки' },
  ],
  SEARCH: {
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
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // /dev/shm в контейнерах обычно всего 64MB — без этого флага Chromium может молча упасть
        '--disable-gpu',
        '--disable-accelerated-2d-canvas'
      ]
    });

    browser.on('disconnected', () => {
      console.log('⚠️  Браузер отключился/упал — пересоздам на следующем цикле');
      browser = null;
    });
  }
  return browser;
}

// Разбирает строку вида "1 низ", "1 ниж, 5 вер" на количество нижних/верхних мест.
// Точное соседство мест страница не показывает (только агрегат по вагону/классу) —
// это только грубый фильтр "в принципе может хватить", реальное соседство проверяется вручную по ссылке.
function parseSeatCounts(seatsLine) {
  const lowerMatch = seatsLine.match(/(\d+)\s*ни[жз]/i);
  const upperMatch = seatsLine.match(/(\d+)\s*вер[хс]?/i);
  const lower = lowerMatch ? parseInt(lowerMatch[1], 10) : 0;
  const upper = upperMatch ? parseInt(upperMatch[1], 10) : 0;
  return { lower, upper, total: lower + upper };
}

// Разбивает текст страницы на блоки по поездам и ищет плацкарт с ценой/местами.
// Структура на странице для каждого поезда: время_отправления...время_прибытия...классы+цены...Выбрать...№номер...маршрут...теги
// "Выбрать" встречается ровно 1 раз на поезд и отделяет его расписание+цены (до) от номера+маршрута (сразу после).
// MIN_LOWER/MIN_TOTAL — минимальные требования: хотя бы 1 нижнее и хотя бы 3 места всего (нужно 3 рядом, 1 из них нижнее).
function parsePlackartTrains(pageText, { minLower = 1, minTotal = 3 } = {}) {
  const found = [];

  const segments = pageText.split(/\nВыбрать\n/);

  // segments[i] заканчивается расписанием+ценами поезда i; segments[i+1] начинается с №номера и маршрута этого же поезда i
  for (let i = 0; i < segments.length - 1; i++) {
    const schedLines = segments[i].split('\n').map(l => l.trim()).filter(Boolean);
    const infoLines = segments[i + 1].split('\n').map(l => l.trim()).filter(Boolean);

    const trainNumberMatch = infoLines[0]?.match(/^№(\S+)/);
    if (!trainNumberMatch) continue;
    const trainNumber = trainNumberMatch[1];
    const route = infoLines[1] && infoLines[1].includes('—') ? infoLines[1] : '';

    // Первое время в этом сегменте — отправление (прибытие идёт позже него)
    const departureTime = schedLines.find(l => /^\d{2}:\d{2}$/.test(l)) || '?';

    const plackartIdx = schedLines.findIndex(l => /^Плац(карт)?$/i.test(l));
    if (plackartIdx === -1) continue;

    const seatsLine = schedLines[plackartIdx + 1] || '';
    const priceLine = schedLines[plackartIdx + 2] || '';

    const priceMatch = priceLine.match(/от\s*([\d\s]+,\d+)\s*₽/);
    const isWaitlist = seatsLine.includes('Лист ожидания') || priceLine.includes('Лист ожидания');

    const counts = parseSeatCounts(seatsLine);
    const meetsRequirement = counts.lower >= minLower && counts.total >= minTotal;

    if (!isWaitlist && priceMatch && meetsRequirement) {
      found.push({
        departureTime,
        trainNumber,
        route,
        seats: seatsLine,
        lower: counts.lower,
        upper: counts.upper,
        total: counts.total,
        price: priceMatch[1].trim() + ' ₽'
      });
    }
  }

  return found;
}

async function searchTickets() {
  try {
    console.log(`\n[${new Date().toLocaleString()}] 🔍 ПРОВЕРКА БИЛЕТОВ (grandtrain.ru)`);

    const browserInstance = await initBrowser();

    for (const route of CONFIG.ROUTES) {
      console.log(`\n🚉 ${route.label}`);

      for (const date of CONFIG.SEARCH.dates) {
        const page = await browserInstance.newPage();
        try {
          await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
          await page.setViewport({ width: 1280, height: 900 });

          const searchUrl = `${CONFIG.BASE_URL}/search/${route.fromCode}-${route.toCode}/${date}/`;
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

            const key = `${route.label}-${date}-${train.trainNumber}-${train.seats}`;
            const now = Date.now();
            const lastTime = lastNotified.get(key);

            // Не уведомляем повторно о том же самом (тот же маршрут+дата+поезд+места) чаще раза в час
            if (!lastTime || now - lastTime > 60 * 60 * 1000) {
              lastNotified.set(key, now);
              await notifyAboutTickets({
                date,
                url: searchUrl,
                routeLabel: route.label,
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
    }

  } catch (error) {
    console.error('❌ Критическая ошибка:', error.message);
  }
}

async function notifyAboutTickets(info) {
  const message = `
🎉 *НАЙДЕНЫ БИЛЕТЫ НА ПЛАЦКАРТ!*

🔎 Маршрут поиска: ${info.routeLabel}
📅 Дата: ${info.date}
🚂 Поезд №${info.trainNumber} (${info.route})
⏰ Отправление: ${info.departureTime}
💺 Места: ${info.seats} (нижних: ${info.lower}, верхних: ${info.upper}, всего: ${info.total})
💰 Цена: от ${info.price}

⚠️ Это агрегат по вагону/классу, НЕ гарантия что 3 места рядом — проверь на сайте вручную перед покупкой!

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
  console.log('║  🚂 РЖД БОТ v5 - grandtrain.ru    ║');
  console.log('╚════════════════════════════════════╝\n');

  console.log('📋 Параметры:');
  console.log('  🚂 Маршруты:');
  CONFIG.ROUTES.forEach(r => console.log(`     • ${r.label}`));
  console.log(`  📅 Даты: ${CONFIG.SEARCH.dates.join(', ')}`);
  console.log(`  💺 Ищем: ПЛАЦКАРТ`);
  console.log(`  ⏰ Проверка: каждые 10 минут\n`);

  try {
    await bot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, `✅ РЖД-бот v5 запущен!\n\nМаршруты (${CONFIG.ROUTES.length}):\n${CONFIG.ROUTES.map(r => '• ' + r.label).join('\n')}`);
  } catch (error) {
    console.error('⚠️  Ошибка приветствия:', error.message);
  }

  await searchTickets();

  console.log('\n✓ Следующая проверка через 10 минут...');
  schedule.scheduleJob(CONFIG.CHECK_INTERVAL, async () => {
    await searchTickets();
  });

  // Heartbeat — если процесс жив, лог появляется каждую минуту.
  // Если хартбиты пропадают без "получен SIGTERM" ниже — контейнер убили извне (OOM/платформа).
  setInterval(() => {
    console.log(`💓 heartbeat ${new Date().toLocaleTimeString()} (процесс жив)`);
  }, 60000);

  const shutdown = async (signal) => {
    console.log(`\n🛑 Получен сигнал ${signal}, завершаю...`);
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startBot().catch(error => {
  console.error('💥 Ошибка:', error);
  process.exit(1);
});
