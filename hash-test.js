const bcrypt = require('bcryptjs');
const motDePasse = '123'; // choisis ton mot de passe de test

bcrypt.hash(motDePasse, 10, (err, hash) => {
  console.log('Hash généré:', hash);
});