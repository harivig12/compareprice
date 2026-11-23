/**
 * Brand names, shared by the matcher (src/normalize.js) and the product
 * catalogue (src/catalog.js). A brand is a facet of a basket line, never a
 * product tag: "amul butter" is the product "butter" with the brand "amul".
 * Multi-word brands are matched as phrases.
 */
export const BRANDS = [
  'amul', 'mother dairy', 'nestle', 'britannia', 'parle', 'itc', 'aashirvaad',
  'fortune', 'saffola', 'tata', 'dabur', 'patanjali', 'haldiram', 'haldirams',
  'maggi', 'kelloggs', 'quaker', 'bingo', 'lays', 'kurkure', 'cadbury',
  'tropicana', 'real', 'paperboat', 'bisleri', 'kinley', 'coca', 'pepsi',
  'surf', 'ariel', 'vim', 'harpic', 'dettol', 'lifebuoy', 'colgate',
  'nandini', 'heritage', 'gowardhan', 'govardhan', 'verka', 'nova',
  'bonn', 'harvest', 'modern', 'english oven', 'wibs',
  'catch', 'everest', 'mdh', 'daawat', 'india gate', 'kohinoor',
  'epigamia', 'yakult', 'danone', 'milky mist', 'id', 'akshayakalpa',
];
