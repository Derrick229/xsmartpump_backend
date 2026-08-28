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

app.get('/api/reservoir', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('reservoir')
      .select('*')
      .single();

    if (error) throw error;

    res.status(200).json(data);
  } catch (err) {
    console.error('Erreur lecture réservoir:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/pay/merci', (req, res) => {
  res.send('<h2>Paiement en cours de traitement, vous pouvez fermer cette page.</h2>');
});

app.get('/pay/:id', async (req, res) => {
  const { id } = req.params;

  const { data: commande, error } = await supabase
    .from('Commande')
    .select('*')
    .eq('id', id)
    .single();

  if (error || !commande) {
    return res.status(404).send('Commande introuvable');
  }

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Paiement XSMARTPUMP</title>
      <script src="https://cdn.kkiapay.me/k.js"></script>
      <style>
        body { font-family: Arial, sans-serif; text-align: center; padding: 40px 20px; }
        h2 { color: #333; }
        .montant { font-size: 28px; font-weight: bold; color: #2563eb; margin: 20px 0; }
      </style>
    </head>
    <body>
      <h2>Confirmez votre paiement</h2>
      <p>Quantite : ${commande.quantite} L</p>
      <div class="montant">${commande.montant} FCFA</div>

      <kkiapay-widget
        amount="${commande.montant}"
        key="${process.env.KKIAPAY_PUBLIC_KEY}"
        position="center"
        sandbox="${process.env.KKIAPAY_SANDBOX}"
        data="${id}"
        callback="https://xsmartpump-backend.onrender.com/pay/merci">
      </kkiapay-widget>
    </body>
    </html>
  `;

  res.send(html);
});


const { kkiapay } = require('@kkiapay-org/nodejs-sdk');

const k = kkiapay({
  privatekey: process.env.KKIAPAY_PRIVATE_KEY,
  publickey: process.env.KKIAPAY_PUBLIC_KEY,
  secretkey: process.env.KKIAPAY_SECRET_KEY,
  sandbox: process.env.KKIAPAY_SANDBOX === 'true'
});

app.post('/api/kkiapay/webhook', async (req, res) => {
  // Vérification de sécurité : la requête vient-elle bien de KKiaPay ?
  const signature = req.headers['x-kkiapay-secret'];
  if (signature !== process.env.KKIAPAY_WEBHOOK_SECRET) {
    console.log('Webhook refusé: signature invalide');
    return res.status(401).send('Non autorisé');
  }

  const { transactionId, isPaymentSucces, event } = req.body;
  console.log('Webhook reçu:', event, 'succès:', isPaymentSucces);

  if (!isPaymentSucces) {
    return res.status(200).send('OK'); // paiement échoué, rien à faire côté commande
  }

  try {
    // On récupère les détails complets de la transaction, y compris notre "data" (l'id de commande)
    const transaction = await k.verify(transactionId);
    const commandeId = transaction.data;

    const { error } = await supabase
      .from('Commande')
      .update({ statut: 'paye' })
      .eq('id', commandeId);

    if (error) throw error;

    console.log('Commande', commandeId, 'marquée comme payée');
    res.status(200).send('OK');
  } catch (err) {
    console.error('Erreur traitement webhook:', err);
    res.status(500).send('Erreur');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});