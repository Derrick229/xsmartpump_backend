require('dotenv').config();
const express = require('express');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { kkiapay } = require('@kkiapay-org/nodejs-sdk');

const app = express();
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const k = kkiapay({
  privatekey: process.env.KKIAPAY_PRIVATE_KEY,
  publickey: process.env.KKIAPAY_PUBLIC_KEY,
  secretkey: process.env.KKIAPAY_SECRET_KEY,
  sandbox: process.env.KKIAPAY_SANDBOX === 'true'
});

app.get('/', (req, res) => {
  res.send('XSMARTPUMP backend en ligne !');
});

app.post('/api/commandes', async (req, res) => {
  const { quantite, montant, device_id } = req.body;

  if (quantite === undefined || montant === undefined || quantite <= 0 || montant <= 0) {
    return res.status(400).json({ error: 'Quantité et montant requis et doivent être positifs' });
  }
  if (!device_id) {
    return res.status(400).json({ error: 'device_id requis' });
  }

  try {
    const { data, error } = await supabase
      .from('Commande')
      .insert([{ quantite, montant, statut: 'en_attente', device_id }])
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
app.get('/api/reservoir/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { data, error } = await supabase
      .from('reservoir')
      .select('*')
      .eq('device_id', deviceId)
      .single();

    if (error) throw error;

    res.status(200).json(data);
  } catch (err) {
    console.error('Erreur lecture réservoir:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
// --- Route spécifique AVANT la route générique ---
app.get('/pay/merci', async (req, res) => {
  const commandeId = req.query.commande_id;

  if (commandeId) {
    try {
      const { error } = await supabase
        .from('Commande')
        .update({ statut: 'paye' })
        .eq('id', commandeId);

      if (error) throw error;
      console.log('Commande', commandeId, 'marquée comme payée (via callback)');
    } catch (err) {
      console.error('Erreur mise à jour statut via callback:', err);
    }
  }

  res.send('<h2>Paiement réussi ! Vous pouvez fermer cette page.</h2>');
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
        name="XSMARTPUMP"
        email="xsmartpump.benin@gmail.com"
        callback="https://xsmartpump-backend.onrender.com/pay/merci?commande_id=${id}">
      </kkiapay-widget>
    </body>
    </html>
  `;

  res.send(html);
});
app.post('/api/kkiapay/webhook', async (req, res) => {
  const signature = req.headers['x-kkiapay-secret'];
  if (signature !== process.env.KKIAPAY_WEBHOOK_SECRET) {
    console.log('Webhook refusé: signature invalide');
    return res.status(401).send('Non autorisé');
  }

  console.log('Corps complet du webhook:', JSON.stringify(req.body, null, 2));

  const { transactionId, isPaymentSucces, event } = req.body;
  console.log('Webhook reçu:', event, 'succès:', isPaymentSucces);

  if (!isPaymentSucces) {
    return res.status(200).send('OK');
  }

  try {
    const commandeId = req.body.data;

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

// La pompe interroge cette route pour savoir s'il y a une commande à distribuer
app.get('/api/commandes/a-distribuer/:deviceId', async (req, res) => {
  const { deviceId } = req.params;
  try {
    const { data, error } = await supabase
      .from('Commande')
      .select('*')
      .eq('statut', 'paye')
      .eq('device_id', deviceId)
      .order('created_at', { ascending: true })
      .limit(1);

    if (error) throw error;

    if (data.length === 0) {
      return res.status(200).json({ commande: null });
    }

    res.status(200).json({ commande: data[0] });
  } catch (err) {
    console.error('Erreur lecture file de distribution:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
// La pompe confirme qu'elle a terminé la distribution
app.patch('/api/commandes/:id/distribuer', async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('Commande')
      .update({ statut: 'distribue' })
      .eq('id', id);

    if (error) throw error;

    res.status(200).json({ message: 'Commande marquée comme distribuée' });
  } catch (err) {
    console.error('Erreur mise à jour distribution:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.post('/api/commandes/:id/distribuer', async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('Commande')
      .update({ statut: 'distribue' })
      .eq('id', id);

    if (error) throw error;

    console.log(`Commande ${id} marquée comme distribuée`);

    res.status(200).json({
      success: true,
      message: 'Commande marquée comme distribuée'
    });

  } catch (err) {
    console.error('Erreur mise à jour distribution:', err);

    res.status(500).json({
      success: false,
      error: 'Erreur serveur'
    });
  }
});


app.get('/api/commandes/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('Commande')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Commande introuvable' });
    }

    res.status(200).json(data);
  } catch (err) {
    console.error('Erreur lecture commande:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.patch('/api/commandes/:id/annuler', async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase
      .from('Commande')
      .update({ statut: 'annule' })
      .eq('id', id);

    if (error) throw error;

    res.status(200).json({ message: 'Commande annulée' });
  } catch (err) {
    console.error('Erreur annulation commande:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// app.patch('/api/reservoir', async (req, res) => {
//  const { niveau_litres } = req.body;
//
  //if (niveau_litres === undefined || niveau_litres < 0) {
    //return res.status(400).json({ error: 'niveau_litres requis et positif' });
  //}

 // try {
 //   const { error } = await supabase
 //     .from('reservoir')
 //     .update({ niveau_litres, derniere_maj: new Date().toISOString() })
 //     .neq('id', 0); // met à jour la seule ligne existante, quel que soit son id

 // if (error) throw error;

   // res.status(200).json({ message: 'Niveau réservoir mis à jour' });
 // } catch (err) {
   // console.error('Erreur mise à jour réservoir:', err);
  //  res.status(500).json({ error: 'Erreur serveur' });
 // }
//});

// =====================================================
// MISE À JOUR DU NIVEAU DU RÉSERVOIR
// PATCH : utilisé par le site/écran
// POST  : utilisé par la pompe via A7670C
// =====================================================

async function mettreAJourReservoir(req, res) {
  const { deviceId } = req.params;
  const { niveau_litres, pourcentage } = req.body;

  try {
    const { data: device, error: errDevice } = await supabase
      .from('devices')
      .select('capacite_litres, seuil_alerte_litres, telephone_proprietaire, alerte_envoyee')
      .eq('id', deviceId)
      .single();

    if (errDevice || !device) {
      return res.status(404).json({ error: 'Dispositif introuvable' });
    }

    let litres;
    const pct = Number(pourcentage);
    if (pourcentage !== undefined && pourcentage !== null && !isNaN(pct) && pct >= 0 && pct <= 100 && device.capacite_litres) {
      litres = Math.round((pct / 100) * device.capacite_litres * 100) / 100;
    } else if (niveau_litres !== undefined && niveau_litres !== null && !isNaN(niveau_litres) && niveau_litres >= 0) {
      litres = Number(niveau_litres);
    } else {
      return res.status(400).json({ error: 'niveau_litres ou pourcentage valide requis' });
    }

    const { error } = await supabase
      .from('reservoir')
      .update({ niveau_litres: litres, derniere_maj: new Date().toISOString() })
      .eq('device_id', deviceId);

    if (error) throw error;

    // --- Détection du franchissement du seuil ---
    let alerteSms = false;
    const seuil = device.seuil_alerte_litres;

    if (seuil !== null && seuil !== undefined) {
      if (litres <= seuil && !device.alerte_envoyee) {
        alerteSms = true;
        await supabase.from('devices').update({ alerte_envoyee: true }).eq('id', deviceId);
      } else if (litres > seuil && device.alerte_envoyee) {
        await supabase.from('devices').update({ alerte_envoyee: false }).eq('id', deviceId);
      }
    }

    res.status(200).json({
      success: true,
      niveau_litres: litres,
      alerte_sms: alerteSms,
      telephone: alerteSms ? device.telephone_proprietaire : null,
      message_sms: alerteSms ? `XSMARTPUMP: niveau du reservoir bas (${litres} L restants). Pensez au reapprovisionnement.` : null
    });
  } catch (err) {
    console.error('Erreur mise à jour réservoir:', err);
    res.status(500).json({ success: false, error: 'Erreur serveur' });
  }
}
app.patch('/api/reservoir/:deviceId', mettreAJourReservoir);
app.post('/api/reservoir/:deviceId', mettreAJourReservoir);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur démarré sur le port ${PORT}`);
});

function verifierToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // format: "Bearer <token>"

  if (!token) {
    return res.status(401).json({ error: 'Token manquant' });
  }

  try {
    const decode = jwt.verify(token, process.env.JWT_SECRET);
    req.utilisateur = decode; // { userId, deviceId, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token invalide ou expiré' });
  }
}

function verifierAdmin(req, res, next) {
  if (req.utilisateur.role !== 'admin') {
    return res.status(403).json({ error: 'Accès réservé à l\'administrateur' });
  }
  next();
}

//Connexion login

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

app.post('/api/login', async (req, res) => {
  const { nom_utilisateur, mot_de_passe } = req.body;

  if (!nom_utilisateur || !mot_de_passe) {
    return res.status(400).json({
      error: 'Nom d\'utilisateur et mot de passe requis'
    });
  }

  try {
    const { data: utilisateur, error } = await supabase
      .from('users')
      .select('*')
      .eq('nom_utilisateur', nom_utilisateur)
      .single();

    if (error || !utilisateur) {
      return res.status(401).json({
        error: 'Identifiants incorrects'
      });
    }

    const motDePasseValide = await bcrypt.compare(
      mot_de_passe,
      utilisateur.mot_de_passe_hash
    );

    if (!motDePasseValide) {
      return res.status(401).json({
        error: 'Identifiants incorrects'
      });
    }

    const token = jwt.sign(
      {
        userId: utilisateur.id,
        deviceId: utilisateur.device_id,
        role: utilisateur.role
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    let capaciteDefinie = false;

    if (utilisateur.device_id) {
      const { data: device } = await supabase
        .from('devices')
        .select('capacite_litres')
        .eq('id', utilisateur.device_id)
        .single();

      capaciteDefinie = !!(device && device.capacite_litres);
    }

    res.status(200).json({
      token,
      doit_changer_mdp: utilisateur.doit_changer_mdp,
      capacite_definie: capaciteDefinie,
      device_id: utilisateur.device_id,
      role: utilisateur.role
    });

  } catch (err) {
    console.error('Erreur login:', err);
    res.status(500).json({
      error: 'Erreur serveur'
    });
  }
});//Changer le mot de passe

app.post('/api/changer-mot-de-passe', verifierToken, async (req, res) => {
  const { ancien_mdp, nouveau_mdp } = req.body;
  const userId = req.utilisateur.userId;

  if (!nouveau_mdp || nouveau_mdp.length < 6) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 6 caractères' });
  }

  try {
    const { data: utilisateur, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !utilisateur) {
      return res.status(404).json({ error: 'Utilisateur introuvable' });
    }

    const ancienValide = await bcrypt.compare(ancien_mdp, utilisateur.mot_de_passe_hash);
    if (!ancienValide) {
      return res.status(401).json({ error: 'Ancien mot de passe incorrect' });
    }

    const nouveauHash = await bcrypt.hash(nouveau_mdp, 10);

    const { error: updateError } = await supabase
      .from('users')
      .update({ mot_de_passe_hash: nouveauHash, doit_changer_mdp: false })
      .eq('id', userId);

    if (updateError) throw updateError;

    res.status(200).json({ message: 'Mot de passe mis à jour' });
  } catch (err) {
    console.error('Erreur changement mot de passe:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
//Routes admin creer un dispositif 

app.post('/api/admin/devices', verifierToken, verifierAdmin, async (req, res) => {
  const { numero_dispositif, nom } = req.body;

  if (!numero_dispositif) {
    return res.status(400).json({ error: 'numero_dispositif requis' });
  }

  try {
    const { data, error } = await supabase
      .from('devices')
      .insert([{ numero_dispositif, nom }])
      .select()
      .single();

    if (error) throw error;

    // Crée aussi la ligne de réservoir associée
    await supabase.from('reservoir').insert([{ device_id: data.id, niveau_litres: 0 }]);

    res.status(201).json(data);
  } catch (err) {
    console.error('Erreur création device:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

//Creer un propriétaire 

app.post('/api/admin/users', verifierToken, verifierAdmin, async (req, res) => {
  const { device_id, nom_utilisateur, mot_de_passe_temporaire } = req.body;

  if (!device_id || !nom_utilisateur || !mot_de_passe_temporaire) {
    return res.status(400).json({ error: 'device_id, nom_utilisateur et mot_de_passe_temporaire requis' });
  }

  try {
    const hash = await bcrypt.hash(mot_de_passe_temporaire, 10);

    const { data, error } = await supabase
      .from('users')
      .insert([{
        device_id,
        nom_utilisateur,
        mot_de_passe_hash: hash,
        doit_changer_mdp: true,
        role: 'proprietaire'
      }])
      .select('id, nom_utilisateur, device_id, role')
      .single();

    if (error) throw error;

    res.status(201).json(data);
  } catch (err) {
    console.error('Erreur création utilisateur:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

function resoudreDeviceId(req) {
  if (req.utilisateur.role === 'admin' && req.query.device_id) {
    return req.query.device_id;
  }
  return req.utilisateur.deviceId;
}

const STATUTS_PAYES = ['paye', 'demarrage', 'distribution', 'distribue'];

// Début de la journée en heure du Bénin (UTC+1)
function debutJourBenin() {
  const decale = new Date(Date.now() + 60 * 60 * 1000);
  decale.setUTCHours(0, 0, 0, 0);
  return new Date(decale.getTime() - 60 * 60 * 1000);
}

app.get('/api/dashboard/resume', verifierToken, async (req, res) => {
  const deviceId = resoudreDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: 'Aucun dispositif associé à ce compte' });

  try {
    const { data, error } = await supabase
      .from('Commande')
      .select('montant, quantite, statut, created_at')
      .eq('device_id', deviceId);

    if (error) throw error;

    const debutAujourdhui = debutJourBenin();
    const il7jours = new Date(debutAujourdhui.getTime() - 6 * 24 * 3600 * 1000);
    const il30jours = new Date(debutAujourdhui.getTime() - 29 * 24 * 3600 * 1000);

    const resume = {
      nb_commandes: data.length,
      nb_en_attente: 0,
      nb_payees_en_cours: 0,
      nb_distribuees: 0,
      nb_annulees: 0,
      chiffre_affaires_total: 0,
      chiffre_affaires_aujourdhui: 0,
      chiffre_affaires_7_jours: 0,
      chiffre_affaires_30_jours: 0,
      litres_distribues_total: 0
    };

    for (const c of data) {
      const date = new Date(c.created_at);

      if (c.statut === 'en_attente') resume.nb_en_attente++;
      if (c.statut === 'annule') resume.nb_annulees++;
      if (['paye', 'demarrage', 'distribution'].includes(c.statut)) resume.nb_payees_en_cours++;
      if (c.statut === 'distribue') {
        resume.nb_distribuees++;
        resume.litres_distribues_total += Number(c.quantite);
      }

      if (STATUTS_PAYES.includes(c.statut)) {
        resume.chiffre_affaires_total += c.montant;
        if (date >= debutAujourdhui) resume.chiffre_affaires_aujourdhui += c.montant;
        if (date >= il7jours) resume.chiffre_affaires_7_jours += c.montant;
        if (date >= il30jours) resume.chiffre_affaires_30_jours += c.montant;
      }
    }

    resume.litres_distribues_total = Math.round(resume.litres_distribues_total * 100) / 100;

    res.status(200).json(resume);
  } catch (err) {
    console.error('Erreur résumé dashboard:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.get('/api/dashboard/commandes', verifierToken, async (req, res) => {
  const deviceId = resoudreDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: 'Aucun dispositif associé à ce compte' });

  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  const { statut } = req.query;

  try {
    let requete = supabase
      .from('Commande')
      .select('id, quantite, montant, statut, created_at')
      .eq('device_id', deviceId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (statut) requete = requete.eq('statut', statut);

    const { data, error } = await requete;
    if (error) throw error;

    res.status(200).json({ commandes: data, limit, offset });
  } catch (err) {
    console.error('Erreur historique dashboard:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

//const CAPACITE_RESERVOIR_L = 25; // provisoire, voir la remarque plus bas

app.get('/api/dashboard/reservoir', verifierToken, async (req, res) => {
  const deviceId = resoudreDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: 'Aucun dispositif associé à ce compte' });

  try {
    const { data: reservoir, error } = await supabase
      .from('reservoir')
      .select('niveau_litres, derniere_maj')
      .eq('device_id', deviceId)
      .single();
    if (error) throw error;

    const { data: device } = await supabase
      .from('devices')
      .select('capacite_litres, seuil_alerte_litres')
      .eq('id', deviceId)
      .single();

    const capacite = device ? device.capacite_litres : null;
    const seuil = device ? device.seuil_alerte_litres : null;

    res.status(200).json({
      niveau_litres: reservoir.niveau_litres,
      capacite_litres: capacite,
      capacite_definie: !!capacite,
      pourcentage: capacite ? Math.round((reservoir.niveau_litres / capacite) * 100) : null,
      seuil_alerte_litres: seuil,
      niveau_bas: seuil !== null && seuil !== undefined ? reservoir.niveau_litres <= seuil : null,
      derniere_maj: reservoir.derniere_maj
    });
  } catch (err) {
    console.error('Erreur réservoir dashboard:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});
app.get('/api/admin/devices', verifierToken, verifierAdmin, async (req, res) => {
  const { data, error } = await supabase.from('devices').select('*').order('created_at');
  if (error) return res.status(500).json({ error: 'Erreur serveur' });
  res.status(200).json(data);
});

app.get('/api/admin/users', verifierToken, verifierAdmin, async (req, res) => {
  const { data, error } = await supabase
    .from('users')
    .select('id, nom_utilisateur, device_id, role, doit_changer_mdp, created_at')
    .order('created_at');
  if (error) return res.status(500).json({ error: 'Erreur serveur' });
  res.status(200).json(data);
});

app.get('/api/dashboard/parametres', verifierToken, async (req, res) => {
  const deviceId = resoudreDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: 'Aucun dispositif associé à ce compte' });

  const { data, error } = await supabase
    .from('devices')
    .select('numero_dispositif, nom, capacite_litres')
    .eq('id', deviceId)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Dispositif introuvable' });
  res.status(200).json({ ...data, capacite_definie: !!data.capacite_litres });
});

app.get('/api/dashboard/parametres', verifierToken, async (req, res) => {
  const deviceId = resoudreDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: 'Aucun dispositif associé à ce compte' });

  const { data, error } = await supabase
    .from('devices')
    .select('numero_dispositif, nom, capacite_litres, seuil_alerte_litres, telephone_proprietaire')
    .eq('id', deviceId)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Dispositif introuvable' });

  res.status(200).json({
    ...data,
    capacite_definie: !!data.capacite_litres,
    seuil_definie: !!data.seuil_alerte_litres
  });
});

app.patch('/api/dashboard/parametres', verifierToken, async (req, res) => {
  const deviceId = resoudreDeviceId(req);
  if (!deviceId) return res.status(400).json({ error: 'Aucun dispositif associé à ce compte' });

  const misesAJour = {};

  if (req.body.capacite_litres !== undefined) {
    const capacite = Number(req.body.capacite_litres);
    if (isNaN(capacite) || capacite <= 0 || capacite > 100000) {
      return res.status(400).json({ error: 'capacite_litres doit être un nombre positif (maximum 100000)' });
    }
    misesAJour.capacite_litres = capacite;
  }

  if (req.body.seuil_alerte_litres !== undefined) {
    const seuil = Number(req.body.seuil_alerte_litres);
    if (isNaN(seuil) || seuil < 0) {
      return res.status(400).json({ error: 'seuil_alerte_litres doit être un nombre positif ou nul' });
    }
    misesAJour.seuil_alerte_litres = seuil;
  }
  if (req.body.telephone_proprietaire !== undefined) {
    const tel = String(req.body.telephone_proprietaire).trim();
    if (tel && !/^\+?[0-9]{8,15}$/.test(tel)) {
      return res.status(400).json({ error: 'Numéro de téléphone invalide (utilisez le format +229XXXXXXXX)' });
    }
    misesAJour.telephone_proprietaire = tel;
  }

  
  if (req.body.telephone_proprietaire !== undefined) {
  misesAJour.telephone_proprietaire = String(req.body.telephone_proprietaire).trim();
   }

  if (Object.keys(misesAJour).length === 0) {
    return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
  }

//  const { error } = await supabase
//    .from('devices')
//    .update(misesAJour)
//    .eq('id', deviceId);

//  if (error) return res.status(500).json({ error: 'Erreur serveur' });
const { data: deviceMaj, error } = await supabase
  .from('devices')
  .update(misesAJour)
  .eq('id', deviceId)
  .select()
  .single();

if (error) {
  console.error('=================================');
  console.error('ERREUR PARAMETRES DEVICE');
  console.error('Device ID :', deviceId);
  console.error('Données envoyées :', misesAJour);
  console.error('Erreur Supabase :', error);
  console.error('=================================');

  return res.status(500).json({
    error: 'Erreur serveur',
    details: error.message
  });
}

console.log('Paramètres sauvegardés :', deviceMaj);

res.status(200).json({
  message: 'Paramètres mis à jour',
  ...misesAJour
});
  res.status(200).json({ message: 'Paramètres mis à jour', ...misesAJour });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});