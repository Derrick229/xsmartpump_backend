const bcrypt = require('bcryptjs');
const motDePasse = '1234'; // choisis ton mot de passe de test

bcrypt.hash(motDePasse, 10, (err, hash) => {
  console.log('Hash généré:', hash);
});