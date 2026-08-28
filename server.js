require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.get('/', (req, res) => {
  res.send('XSMARTPUMP backend en ligne !');
});

app.post('/api/commandes', async (req, res) => {
  const { quantite, montant } = req.body;

  if (quantite === undefined || montant === undefined || quantite <= 0 || montant <= 0) {
    return res.status(400).json({ error: 'Quantité et montant requis et doivent être positifs' });
  }

  try {
    const { data, error } = await supabase
      .from('Commande')
      .insert([{ quantite, montant, statut: 'en_attente' }])
      .select()
      .single();

    if (error) throw error;

    console.log('Commande créée:', data);
    res.status(201).json(data);
  } catch (err) {
    console.error('Erreur création commande:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});