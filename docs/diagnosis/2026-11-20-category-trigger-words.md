# Category trigger words (sweets / pooja / packaged), 2026-11-20

Purpose: sourced word lists for classifying Indian grocery product titles and site category paths. Validated read-only against `basket.db` (1742 rows, 1187 distinct products, 189 distinct queries; whole-word, case-insensitive match on `product`). Method: `SELECT DISTINCT query, product FROM prices`, regex `(^|[^a-z])word(s|es)?([^a-z]|$)`.

Verdicts: **SAFE** = title-level refusal ok. **CAT** = category-path only. **DROP** = do not use.
"Unvalidated" = 0 saved products contain the word, so there is no counter-evidence in saved data, only reasoning. The DB is small, so treat these as lower confidence than words with hits.

## Sources

| # | Source | Version / date | Licence | Used for |
|---|--------|----------------|---------|----------|
| 1 | Google Product Taxonomy, https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt | `Google_Product_Taxonomy_Version: 2021-09-21` | Google, free to use for product feeds | group names, generic words |
| 2 | Open Food Facts categories taxonomy, https://raw.githubusercontent.com/openfoodfacts/openfoodfacts-server/main/taxonomies/food/categories.txt (static.openfoodfacts.org URL returned 404) | main, fetched 2026-11-20 | ODbL 1.0 | Indian sweet names |
| 3 | Wikipedia, https://en.wikipedia.org/wiki/List_of_Indian_sweets_and_desserts (raw wikitext) | fetched 2026-11-20 | CC BY-SA 4.0 | sweet names and spelling variants |
| 4 | Own fixtures `test/fixtures/sites/*.json` (bigbasket, instamart, zepto, milkbasket, kpn) | repo | own | category-field shapes |
| 5 | Saved DB `/home/a/basket-data/basket.db` (read-only) | 2026-11-20 | own | false-positive validation |
| 6 | BigBasket top-level category names as listed on a CNET app page, https://download.cnet.com/royalspiceland-online-grocery/3000-2649_4-78447912.html | 2020 snapshot | n/a | top-level only (see Not accessible) |

Evidence per source:
- **Google (1)**: `Food, Beverages & Tobacco > Food Items > Candy & Chocolate` (id 4748); `> Snack Foods` (423; children Chips, Crackers, Popcorn, Puffed Rice Cakes, Cereal & Granola Bars, Trail & Snack Mixes, Pretzels); `> Prepared Foods` (5814; Prepared Appetizers & Side Dishes, Prepared Meals & Entrees); `> Bakery` (1876; Cookies, Cakes & Dessert Bars, Pastries, Fudge, Donuts); `> Condiments & Sauces` (427; incl. Relish & Chutney, Curry Sauce, Pickled Fruits & Vegetables). Pooja: `Religious & Ceremonial > Religious Items` (97; Prayer Beads, Religious Altars); `Home & Garden > Decor > Home Fragrances > Incense` (3686) and `> Candles` (588), `Incense Holders` (4741).
- **OFF (2)**: `en:Laddu, ladoo` (line 39058), `Besan Laddu, besan ladoo`, `Chikki`, `Gulab jamun`, `Soan papdi` (all parent `en:Confectioneries`), `Halva` with fr synonyms halwa/helva (41580), `Shrikhand` (57015), `Papadum, Papad` (37238), `Biscuits, biscuit, cookies, cookie` (33566), `Instant beverages`, `Frozen ...` families. OFF has no hi/ta synonyms for these entries and no barfi, peda, jalebi or mithai entries, so those come from Wikipedia.
- **Wikipedia (3)** page names/spellings: Barfi/Burfi, Peda/Pedha/Pera/Dharwad pedha, Laddu/Laddoo, Halwa (Sohan, Mahim, Ashoka, Gajar ka halwa), Mysore pak, Soan papdi/Sohan papdi, Gulab jamun/Kala jamun, Rasgulla/Ras malai, Kaju katli, Jalebi/Imarti, Chikki, Gajak (Gavvalu is a different sweet), Rewri/Revdi (not on page, common retail spelling), Sandesh/Sondesh, Kheer/Payasam/Phirni, Rabri, Kulfi, Petha, Modak, Shrikhand, Basundi, Ghevar, Malpua, Mohanthal, Kalakand, Cham cham, Balu shahi, Boondi, Shankarpali, Sheera, Kesari bat, Puran poli, Holige/Obbattu/Bobbatlu.
- **Fixtures (4)** category field shapes seen, all staples only: bigbasket `tlc_name` "Foodgrains, Oil & Masala", `mlc_name` "Dals & Pulses", `llc_name` "Toor, Channa & Moong Dal"; instamart `superCategory` "Atta, Rice and Dals", `subCategoryType` "Toor Dal"; zepto `primaryCategoryName` "Atta, Rice, Oil & Dals"; kpn `l0` "Rice, Atta & Dal (1_13)", `l1` "Pulses & Dals (2_1313)" / "Loose Provisions (2_1315)". No sweets/pooja/snack category strings exist in the fixtures, so the category-path words below come from Google/OFF names plus general retailer naming and are **not verified against live trees**.

## Group 1: sweets

### Title words (SAFE)
| words | source | saved-DB hits |
|---|---|---|
| laddu, laddus, ladoo, ladoos, laddoo, laddoos, ladu | OFF, Wikipedia | 2 (both a laddu product, correct) |
| barfi, burfi, barfee | Wikipedia | 0 (unvalidated) |
| pedha, pede, penda | Wikipedia | 0 (unvalidated) |
| mysore pak, mysorepak, mysore paak | Wikipedia | 0 as a phrase |
| soan papdi, sohan papdi, son papdi, sonpapdi | OFF, Wikipedia | 0 |
| gulab jamun, gulabjamun, kala jamun | OFF, Wikipedia | 0 |
| rasgulla, rasagulla, roshogolla, rasmalai, ras malai | Wikipedia | 0 |
| kaju katli, kaju-katli, kajukatli, katli | Wikipedia | 0 |
| jalebi, jilebi, jilapi, imarti | Wikipedia | 0 |
| chikki, chikkis | OFF, Wikipedia | 0 |
| gajak, gajjak, gazak, rewari, rewri, revdi | Wikipedia, retail | 0 |
| sandesh, sondesh | Wikipedia | 0 |
| kheer, payasam, paysam, phirni, rabri, rabdi, shrikhand, basundi | OFF, Wikipedia | 0 |
| kulfi, petha, modak, ghevar, malpua, mohanthal, kalakand, cham cham, balushahi, motichoor, shankarpali, gujiya, ghujia | Wikipedia | 0 |
| mithai, mithaai, confectionery, confectionary, gummies, gummy, toffee, lollipop, nougat, marzipan | Google (Candy & Chocolate), OFF (Confectioneries) | 0 |

### Category-path words (match in site category text)
| words | source | note |
|---|---|---|
| sweets, sweet, mithai, indian sweets, dessert, desserts, confectionery | Google, OFF, retail | whole path only; never a title |
| chocolates, chocolate, candies, candy, toffees, candy & chocolate | Google 4748 | |
| halwa, halva, peda, mysore, kaju | Wikipedia | only as a leaf of a sweets path |
| ice cream, kulfi, frozen desserts | Google | optional |
| cakes, pastries, bakery, cakes & dessert bars | Google Bakery 1876 | only if "cakes" should count as sweets |
| jelly, pudding | Google (Pudding & Gelatin Snacks) | |

### Dropped / risky
| word | verdict | reason and counterexample |
|---|---|---|
| sweet | DROP (title), CAT | 14 hits: "Sweet Sanskriti Ghee Besan Laddu" (brand), queries besan, bread, ghee, mosambi, sweet corn; also sweet lime, sweet potato |
| mysore (alone) | DROP | "Mysore Parupu" is masoor dal: queries red split masoor dal, whole masoor dal |
| pak, mint, bar | DROP | "Tetra Pak" (buttermilk); mint leaves, toothpaste; "Dishwash Bar", sesame seeds, ginger (25 hits) |
| gulab | DROP | "Gulab Filtered Groundnut Oil" is a brand (query groundnut oil); gulab jal is rose water |
| kaju (alone) | DROP | "Raw Whole Cashews ... Kaju" (queries cashew whole, pista) |
| peda (alone) | CAT | "Patanjali Pachak Hing - Peda" for query hing |
| halwa (alone) | CAT | "Bansi Upma Rava" listing mentions halwa (query upma rava); sooji/rava descriptions |
| dessert (title) | CAT | "Saffrona Poppy Seeds" listing text (query poppy seeds) |
| candy | CAT, not title | candy sugar / rock candy / mishri (khadi sakkar) is a staple. Unvalidated |
| chocolate (title) | CAT | chocolate-flavoured oats, protein powder, cocoa; baking chips. Unvalidated |
| cake, cakes, pudding, jelly | CAT | cake mix, jelly in "jelly mix", rice pudding; also packaged. Unvalidated |
| fudge, brownie, truffle | CAT | "truffle oil" (condiment); low volume |

## Group 2: pooja

### Title words (SAFE)
| words | source | saved-DB hits |
|---|---|---|
| pooja, puja, poojan, pujan | retail, Google (Religious & Ceremonial) | 9 (pooja oil, "Puja Ghee"); intended: refuses for generic ghee/oil lines |
| agarbatti, agarbathi, agarbathis, incense, dhoop, dhup, dhoopam, loban, sambrani, guggul | Google (Incense 3686) | 1 (incense, mosquito repellent: still non-edible, ok) |
| camphor, karpooram, karpur, kapur | Google/retail | 1 (camphor in "Pooja Oil (Non-Edible)", ok) |
| diya, diyas, deepam lamp, lamp oil, wick, wicks, batti, bati, panju, jyot | Google (Candles 588), retail | 3 (all "Pooja Panju Wicks", ok) |
| kumkum, kumkuma, kunkum, kungumam, sindoor, sindur, vermilion, haldi kumkum, roli, mauli, kalawa, abir, gulal | retail | 0 (unvalidated) |
| havan, hawan, samagri, samidha, ashtagandha, rudraksha, gangajal, gangajali | retail | 0 |

### Category-path words
| words | note |
|---|---|
| pooja, puja, pooja needs, pooja essentials, pooja items, religious, religious items, incense, agarbatti, dhoop, camphor, lamps, diyas, wicks | Google "Religious & Ceremonial > Religious Items" 97 |
| chandan, kalash, aarti, arti, idol, bell, deepam, tulsi | only inside a pooja path; ambiguous alone |

### Dropped / risky
| word | verdict | reason |
|---|---|---|
| deepam / deep | DROP (title) | "Deepam" is a gingelly-oil brand in Tamil Nadu; "Deep" is an Indian food brand. "Pancha Deepam Pooja Oil" is caught by "pooja" anyway |
| kapoor | DROP | surname/brand |
| aarti, arti | CAT | Aarti is a food brand name (unvalidated) |
| kalash, bell, idol | CAT | brand/utensil words (unvalidated) |
| chandan, sandalwood | CAT | chandan soap, sandalwood face pack, tilak. Edible chandan syrup exists |
| tulsi | DROP | tulsi tea, tulsi drops, edible herb |
| lakshmi, ganesh | DROP | very common brand names (rice, atta) |
| lamp (alone), wick (alone) | CAT | "lamp" ok in path; "wick" can be "wicked" no, but candle wicks are a separate non-pooja item |

## Group 3: packaged

### Title words (SAFE)
| words | source | saved-DB hits |
|---|---|---|
| namkeen, namkin, bhujia, chivda (not "poha chivda"), mathri, murukku, chakli, bhakarwadi, khakhra | Google (Snack Foods), Indian snack names | 1 (namkeen on peanuts query, correct refusal) |
| mixture (with garlic, hot, south indian) | retail | 3 ("Garlic Mixture", queries garlic, makhana: correct refusal) |
| chips, crisps, wafers, nachos, kurkure, popcorn, pretzels, crackers, cracker | Google Snack Foods 423 | cracker 1, popcorn 1 (ok) |
| biscuit, biscuits, cookie, cookies, rusk | OFF 33566, Google Bakery Cookies | 7+2+9 hits, queries biscuits, badam, jaggery, cinnamon, rusk: all correct refusals |
| noodles, ramen, maggi, yippee, pasta, macaroni, cornflakes, corn flakes, muesli, granola | Google, OFF | noodles 15, maggi 13 (queries black pepper, makhana: flavoured noodles, correct) |
| ready to eat, ready-to-eat, ready to cook, ready-to-cook, rte, rtc, heat and eat, readymade | OFF, Google Prepared Foods 5814 | 6 hits: "Ready To Eat Rajma Masala" (query rajma masala), "Ready to Cook Boiled Chinese Potato" (query potato): correct |
| premix, instant mix, ready mix, batter (idli/dosa) | retail | batter 3 (queries dosa rice, idli rice: correct) |
| ketchup, pickle, pickles, achar, papad, papadum, appalam, fryums | Google (Condiments), OFF (Papadum) | 0 |
| canned, tinned, instant noodles, instant soup | Google | 0 |

### Category-path words
| words | source |
|---|---|
| snacks, snacks & branded foods, namkeen, chips, biscuits, cookies, crackers, instant food, ready to eat, ready to cook, ready meals, noodles, pasta, soups, sauces, spreads, jams, breakfast cereals, frozen food, frozen snacks, packaged food, bakery, cakes, canned food | Google 423/5814/1876/427, BigBasket top-level "Snacks & Branded Foods", "Gourmet & World Food" (cnet snapshot) |

### Dropped / risky
| word | verdict | counterexample (saved DB) |
|---|---|---|
| mix | DROP | "Bread Mix" for bread; "Dry Fruit Mix - Kaju..." for pista; "Spice Mix" for chole masala; "Mixed dal" |
| mixed | DROP | mixed dal, mixed vegetables |
| frozen | CAT | "Frozen Green Peas" under query "dried green peas", "Frozen Mixed Vegetables" for "mixed dal", frozen sweet corn, frozen potato. For query "peas" frozen peas is a legitimate staple |
| instant | CAT | 17 hits: "Instant Popcorn Butter" (query butter), "Instant Gravy Masala" (chole masala), instant oats (query oats), instant rasam powder |
| ready | DROP | use the phrases only |
| snack, snacks | CAT | "Phool Makhana ... Crispy Nutty Snack" (query makhana), "Kala Namak Black Salt ... Snacks" seasoning |
| puffs, puffed | CAT | "Makhana Puffs" (query makhana), "Puffed Rice" (query puffed rice) |
| makhana, poha, upma, murmura, oats | DROP | raw staples with 8, 31, 4, and 9 saved hits; queries makhana, poha, oats |
| vermicelli | CAT | 18 hits incl. query "vermicelli" (staple), "roasted vermicelli" |
| wada, vada | DROP | "Wada/Vada Kolam Raw Rice" (queries kolam rice, urad dal for idli) |
| cereal, flakes | DROP | "Oats ... Cereal" (query oats); chilli/coconut/poha flakes |
| bar, bars | DROP | dishwash/soap bars (25 hits), granola bars only in path |
| soup | CAT | "Corn Flour ... Ideal for soups" (query corn flour) |
| kit, combo, packed | DROP | "Biryani Kit" (query biryani masala), "Combo" (potato, onion, egg, cleaners: 17 hits), "Packed" in rava description |
| sauce, chutney, spread, jam | CAT | chilli/curry/chutney powder and "tamarind sauce" ambiguity; unvalidated |
| pasta | CAT if worried | "pasta masala" is a spice; unvalidated |
| sev | CAT | "sev" is fine in titles for namkeen but "sev" also reads as apple in Hindi retail names; unvalidated |
| popcorn | SAFE but note | "popcorn kernels / corn for popping" is a raw staple (unvalidated); consider CAT |

## Not accessible
- Kaggle dataset `surajjha101/bigbasket-entire-product-list-28k-datapoints`: the download API returned an empty/404 response without login; GitHub code search needs authentication; no public mirror found. So BigBasket `category/sub_category/type` values were **not** extracted, and category-path words above are not checked against the real BigBasket tree. Only the 6 top-level names from a 2020 CNET page were used.
- OFF `static.openfoodfacts.org/.../categories.txt` returned 404; the GitHub raw file worked.
- The fixtures hold only staples (dal, atta, rice), so Blinkit/Zepto/Instamart/KPN/JioMart/Milkbasket sweets, pooja and snack category strings are unseen.
- The saved DB has no category column, only titles, so category-path words were not validated against stored paths.

## Next step
Run one live category capture per site (sweets, pooja, snacks aisles) into scrubbed fixtures to confirm the category-path words, and re-run the title validation as the DB grows.
