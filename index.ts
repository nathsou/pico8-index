import puppeteer, { Browser } from "puppeteer";
import { parse } from "node-html-parser";

const LEXALOFFLE_BASE_URL = "https://www.lexaloffle.com";

type Cart = {
  id: string;
  title: string;
  url: string;
  favoriteCount: number;
};

async function retrieveCartridge(id: string): Promise<Cart> {
  const response = await fetch(`${LEXALOFFLE_BASE_URL}/bbs/?pid=${id}`);
  const html = await response.text();
  const root = parse(html);
  const url = root
    .querySelector('a[title="Open Cartridge File"]')
    ?.getAttribute("href");

  const title = root.querySelector('div[class="post_title2"]')?.text;
  const favs = root.querySelector('div[title="Give this post a star"]')
    ?.nextElementSibling?.text;

  if (url != null && title != null && favs != null) {
    const isFavsValid = /\d+/.test(favs);

    return {
      id,
      title,
      url,
      favoriteCount: isFavsValid ? Number(favs) : 0,
    };
  }

  throw new Error(`Cartridge ${id} not found`);
}

class Pool {
  private promises: Promise<any>[] = [];

  add(promise: Promise<any>) {
    this.promises.push(promise);
  }

  async wait(chunkSize = 25) {
    while (this.promises.length > 0) {
      const chunk = this.promises.splice(0, chunkSize);
      await Promise.allSettled(chunk);
    }
  }
}

async function listCartsOnPage(
  browser: Browser,
  n: number,
  retries = 5
): Promise<string[]> {
  if (retries === 0) {
    throw new Error(`Failed to retrieve carts on page ${n}`);
  }

  try {
    const url = `${LEXALOFFLE_BASE_URL}/bbs/?cat=7#sub=2&page=${n}&mode=carts`;
    const page = await browser.newPage();
    await page.goto(url);

    const cartSelector = 'div[id^="pdat_"]';

    try {
      await page.waitForSelector(cartSelector, { timeout: 5000 });
    } catch (e) {
      return [];
    }

    const cartDivs = await page.$$(cartSelector);
    const cartIds: string[] = [];

    for (const cartDiv of cartDivs) {
      const cartId = await cartDiv.evaluate((div) => div.id);
      cartIds.push(cartId.split("pdat_")[1]);
    }

    await page.close();

    console.log(`Retrieved ${cartIds.length} carts on page ${n}`);
    return cartIds;
  } catch (e) {
    console.error(`Error retrieving carts on page ${n}: ${e}`);
    return listCartsOnPage(browser, n, retries - 1);
  }
}

async function listCarts(browser: Browser): Promise<string[]> {
  const carts: string[] = [];
  let page = 1;
  let firstEmptyPage = Infinity;

  function fetchNextPages(count: number) {
    const promises = [];

    for (let i = 0; i < count; i += 1) {
      if (page <= firstEmptyPage) {
        page += 1;
        const promise = new Promise(async (resolve) => {
          try {
            const cartIds = await listCartsOnPage(browser, page);
            if (cartIds.length === 0) {
              firstEmptyPage = page;
            }

            carts.push(...cartIds);
            resolve(null);
          } catch (e) {
            console.error(`Error fetching carts on page ${page}: ${e}`);
            resolve(null);
          }
        });

        promises.push(promise);
      }
    }

    return promises;
  }

  while (page < firstEmptyPage) {
    const promises = fetchNextPages(10);
    await Promise.all(promises);
  }

  return carts;
}

async function downloadCartridge(url: string, path: string): Promise<void> {
  const response = await fetch(url);
  await Bun.write(path, response);
}

async function retrieveCarts(ids: string[]): Promise<Cart[]> {
  const carts: Cart[] = [];
  const pool = new Pool();

  for (const id of ids) {
    const promise = new Promise(async (resolve) => {
      try {
        const cart = await retrieveCartridge(id);
        carts.push(cart);
        console.log(`[${carts.length}/${ids.length}] ${cart.title}`);
      } catch (e) {
        console.error(`Error retrieving cart ${id}: ${e}`);
      } finally {
        resolve(null);
      }
    });

    pool.add(promise);
  }

  await pool.wait();

  return carts;
}

const CARTS_JSON = "carts.json";

async function loadPersistedCarts(): Promise<Cart[]> {
  return await Bun.file(CARTS_JSON).json();
}

async function fetchAllCarts(): Promise<Cart[]> {
  const browser = await puppeteer.launch({ headless: true });
  const cartIds = await listCarts(browser);
  await browser.close();

  const carts = await retrieveCarts(cartIds);
  const cartsByFavs = [...carts].sort(
    (a, b) => b.favoriteCount - a.favoriteCount
  );

  return cartsByFavs;
}

async function downloadCarts(carts: Cart[]): Promise<void> {
  const pool = new Pool();

  for (let i = 0; i < carts.length; i++) {
    const promise = new Promise(async (resolve) => {
      try {
        const cart = carts[i];
        const cartPath = `carts/${i} - ${cart.title.replaceAll(
          "/",
          "_"
        )}.p8.png`;

        await downloadCartridge(`${LEXALOFFLE_BASE_URL}/${cart.url}`, cartPath);
        console.log(`Downloaded ${cart.title} [${i}/${carts.length}]`);
        resolve(cartPath);
      } catch (e) {
        console.error(`Error downloading cart ${i + 1}: ${e}`);
        resolve(null);
      }
    });

    pool.add(promise);
  }

  await pool.wait();
}

async function main() {
  const carts = await fetchAllCarts();
  await Bun.write(CARTS_JSON, JSON.stringify(carts, null, 2));
}

main();
