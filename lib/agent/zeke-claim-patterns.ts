/**
 * The phrases Zeke's completion guard reads (v2 Phase 3). Pattern tables only;
 * the matching, the excuses and the fixed lines are in lib/agent/oxwal.ts.
 *
 * This file is ASCII-only: every letter of a non-Latin script is written as a
 * \uXXXX escape, so it reads the same in any editor and a reviewer can diff it.
 */
export const CLAIM_VERB =
  '(?:sent|paid|transferr?ed|wired|remit{1,2}ed|set{1,2}led|disbursed|released(?!\\s+by\\b)|proces{1,2}ed|executed|completed|submit{1,2}ed|approved(?!\\s+by\\b)|signed(?!\\s+(?:in|up|out|on|off|by)\\b)|authori[sz]ed(?!\\s+by\\b)|funded|deposited|credited|refunded|reimbursed|swapp?ed|converted|withdrawn|withdrew|invested|allocated|redeemed|swept|dispatched|finali[sz]ed|cleared|delivered|initiated|forwarded|actioned|transmitted|debited|payed|paied)';
export const ADVERBS = '(?:just|already|now|successfully|also|finally|duly|safely|fully|all|been|being)';
export const BOUNDARY = String.raw`[,;:!.\-\u2013\u2014]`;

export type ClaimPattern = {
  re: RegExp;
  /** Said of a payment only; a discussion turn lets a bare "done" be just a word. */
  strictOnly?: boolean;
  /** The speaker says they did it: a conditional opening the sentence does not excuse it. */
  firstPerson?: boolean;
  /** Bare "is sent": habitual when a condition sits anywhere in the sentence. */
  tensed?: boolean;
  /** Said of the future ("will arrive"): excused by an approval or condition anywhere in the sentence. */
  wholeSentence?: boolean;
  /** Said as "it's sent": a condition AFTER it ("once approved") makes it a rule; one before it does not. */
  conditionAfter?: boolean;
};

export const rx = (source: string) => new RegExp(source, 'g');

export const WORD_BREAK = '[^a-z0-9]{0,6}';
// A claim opens a clause: the start of the sentence, or after a comma, colon, dash or full stop.
export const AT_START = String.raw`(?:^|[,;:.!?\u2013\u2014(])[^a-z0-9]{0,6}(?:(?:ok|okay|great|alright|perfect|sure|yes|yep|good|cool|nice|so|now|and|well|there you go|good news|great news)[^a-z0-9]{1,6}){0,4}`;

export const ENGLISH_CLAIMS: readonly ClaimPattern[] = [
  { re: rx(String.raw`\b(?:i|we|zeke)(?:'?ve|\s+(?:have|has|had|did)|'d)?\s+(?:(?:just|already|now|successfully|also|finally|duly|safely|(?:gone|went|go) ahead and)\s+)*${CLAIM_VERB}\b`), firstPerson: true },
  { re: rx(String.raw`\b(?:i|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+)?made\s+(?:the|a|your|that|this)\s+(?:payment|transfer|payout|transaction|deposit|withdrawal)\b`), firstPerson: true },
  { re: rx(String.raw`\b(?:i|we)(?:'ve|\s+have)?\s+(?:just\s+|already\s+)?moved\s+(?:the|your|those)\s+(?:funds?|money|usdc)\b`), firstPerson: true },
  { re: rx(String.raw`\b(?:has|have|had|was|were|got|is|are|be|been)\s+(?:${ADVERBS}\s+)*${CLAIM_VERB}\b`), tensed: true },
  { re: rx(String.raw`\b(?:i(?:'m|\s+am)|we(?:'re|\s+are)|zeke\s+is)\s+(?:(?:now|just|currently|already|actually)\s+)*(?:sending(?!\s+you\b)|paying(?!\s+(?:attention|close|special)\b)|transferring|wiring|remitting|releasing|executing|processing|settling|disbursing|dispatching|refunding|swapping|withdrawing|depositing|submitting|approving|signing)\b`), firstPerson: true },
  { re: rx(String.raw`\b(?:is|are)\s+(?:now\s+|currently\s+)?(?:on (?:its|their|the) way|in transit|en route|processing)\b`) },
  { re: rx(String.raw`\b(?:sending|paying|transferring|wiring|remitting|approving|signing|releasing|executing|processing|settling|submitting)\s+(?:it|this|that|them|the (?:money|funds|payment|transfer))\s+(?:now|right now|today|immediately)\b|\b(?:sending|paying|transferring|approving|releasing)\s+(?:now|right now)\b`) },
  { re: rx(String.raw`\bprocessing\s+(?:the|your|this|that)\s+(?:payment|transfer|payout|transaction|batch|withdrawal|refund)\b`) },
  { re: rx(String.raw`\b(?:payments?|payouts?|transfers?|money|funds?|transactions?)\s+${CLAIM_VERB}\b`) },
  { re: rx(String.raw`\b(?:payments?|payouts?|transfers?|transactions?|batch(?:es)?|withdrawals?|swaps?|settlements?|deposits?|disbursements?|remittances?|refunds?)\s+(?:(?:is|are|was|were|has|have|had|been|now|all|just|successfully)\s+)*(?:complete[d]?|successful(?:ly)?|confirmed|done|finali[sz]ed|received|delivered|cleared|executed|processed|approved|released)\b`) },
  { re: rx(String.raw`\bsuccess{1,2}fully\s+${CLAIM_VERB}\b`) },
  { re: rx(String.raw`\b${CLAIM_VERB}\s+success{1,2}fully\b`) },
  { re: rx(String.raw`\b(?:payment|transfer|transaction|it|that|this)\s+(?:has\s+|have\s+)?(?:went|gone)\s+through\b`) },
  { re: rx(String.raw`\bconsider (?:it|this|that) (?:paid|sent|settled|transferred)\b`) },
  { re: rx(String.raw`\b(?:money|funds?|usdc|payment)\s+(?:has\s+|have\s+)?moved\b|\b(?:has|have|had)\s+(?:now\s+|already\s+)?received\s+(?:the|your|their|its)\s+(?:money|funds|payment|transfer|usdc)\b|\b(?:funds?|money|payment|usdc)\s+(?:has\s+|have\s+)?(?:arrived|landed|reached\s+(?:them|acme|the))\b|\b(?:has|have|had|just)\s+(?:gone|went)\s+out\b|\b(?:transaction|tx)\s+(?:id|hash|digest)\s*[:=]\s*(?:0x)?[a-f0-9]{6,}`) },
  // A claim as the whole of the sentence, or its first word: "Paid!", "Sent, thanks", "Payment sent."
  { re: rx(String.raw`${AT_START}(?:(?:all|it is|it's|its|that's|thats|that is|everything is)\s+)?(?:paid|sent|settled|executed|transferred|processed|released|success|successful)\b(?:\s+(?:it|out|off|now|already|successfully))?[^a-z0-9]{0,6}(?:${BOUNDARY}|$)`) },
  { re: rx(String.raw`${AT_START}(?:(?:all|it is|it's|that's|everything is)\s+)?(?:done|completed|finished|sorted|handled)\b(?=[^a-z0-9]{0,6}(?:${BOUNDARY}|$)|\s+(?:i|we|it|that|this|and|now|all|everything)\b)`), strictOnly: true },
  { re: rx(String.raw`\b(?:it's|its|that's|thats|everything's|all)\s+(?:all\s+)?(?:done|sorted|handled)\b|\ball done\b|\bdone and dusted\b|\bconsider (?:it|this|that) (?:done|handled|sorted)\b|\btaken care of\b|\byou(?:'re| are) all set\b|\bgood to go\b`), strictOnly: true },
  { re: rx(String.raw`\b(?:funds?|money|usdc|payment|transfer)\s+(?:is|are|will be|should be|'ll be)\s+(?:arriving|landing|reaching|with (?:them|acme|the)|in (?:their|the) account)\b|\b(?:will|should|'ll)\s+(?:arrive|land|reach)\s+(?:in|within|by|today|tomorrow|shortly|soon|on)\b`), strictOnly: true, wholeSentence: true },
];

/** Latin-script languages. The text is read without accents, so the patterns are written without them. */
export const LATIN_CLAIMS: readonly ClaimPattern[] = [
  // Indonesian and Malay
  { re: rx(String.raw`\b(?:sudah|telah|udah)\s+(?:saya\s+|kami\s+)?(?:\w+\s+){0,2}?(?:di|ter|me)?(?:kirim|bayar|transfer|hantar)\w*`) },
  { re: rx(String.raw`\bpembayaran\s+(?:telah\s+|sudah\s+)?(?:berhasil|sukses|selesai|berjaya|diterima)\b|\b(?:berhasil|sukses|berjaya)\s+(?:di)?(?:kirim|bayar|transfer|hantar)\w*`) },
  { re: rx(`${AT_START}(?:terkirim|terbayar|lunas|dikirim|dibayar|ditransfer|dihantar)\\b${WORD_BREAK}(?:${BOUNDARY}|$)`) },
  { re: rx(`${AT_START}(?:selesai|beres|siap|tuntas)\\b${WORD_BREAK}(?:${BOUNDARY}|$)`), strictOnly: true },
  // Tagalog
  { re: rx(String.raw`\b(?:naipadala|ipinadala|nabayaran|binayaran|nailipat|inilipat)(?:\s+na)?\b|\bbayad\s+na\b`) },
  { re: rx(String.raw`\b(?:tapos|natapos)\s+na\b`), strictOnly: true },
  // Vietnamese
  { re: rx(String.raw`\bda\s+(?:\w+\s+){0,1}?(?:gui|thanh toan|chuyen|tra tien|xu ly|thuc hien|hoan tat|hoan thanh)\b|\bthanh cong\b`) },
  { re: rx(String.raw`\b(?:hoan tat|hoan thanh|xong roi|da xong)\b`), strictOnly: true },
  // Spanish, Portuguese, Italian
  { re: rx(String.raw`\b(?:he|hemos|ha|han)\s+(?:\w+\s+){0,1}?(?:enviado|pagado|transferido|realizado|procesado|completado|ejecutado|aprobado|firmado|abonado|depositado)\b|\bse\s+(?:ha\s+)?(?:enviado|pagado|transferido|realizado)\b`) },
  { re: rx(String.raw`\b(?:ha|han|fue|fueron)\s+(?:sido\s+)?(?:enviad[oa]|pagad[oa]|transferid[oa]|procesad[oa]|completad[oa]|ejecutad[oa]|aprobad[oa]|realizad[oa]|efectuad[oa]|abonad[oa])s?\b`) },
  { re: rx(String.raw`\b(?:pago|pagamento|transferencia|transferenza|trasferimento|envio|transacao|transazione|operacion|bonifico)\s+(?:(?:ha|foi|e)\s+(?:sido\s+|stato\s+)?)?(?:enviad[oa]|inviato|realizad[oa]|realizzato|conclu[i]d[oa]|completad[oa]|completato|efetuad[oa]|effettuato|eseguito|exitos[oa]|processad[oa]|elaborato|aprovad[oa]|aprobad[oa]|riuscito|confermato)s?\b`) },
  { re: rx(String.raw`\b(?:enviei|paguei|transferi|efetuei|realizei|processei|executei|aprovei|liberei|quitei)\b`) },
  { re: rx(String.raw`\b(?:foi|foram|ja foi|esta|estao)\s+(?:\w+\s+){0,1}?(?:enviad[oa]s?|pag[oa]s?|transferid[oa]s?|processad[oa]s?|conclu[i]d[oa]s?|executad[oa]s?|realizad[oa]s?|efetuad[oa]s?|aprovad[oa]s?)\b`) },
  { re: rx(String.raw`\b(?:ho|abbiamo)\s+(?:\w+\s+){0,1}?(?:inviato|pagato|trasferito|eseguito|effettuato|bonificato|approvato|completato|elaborato|rimborsato)\b`) },
  { re: rx(String.raw`\b(?:e stato|e stata|sono stati|sono state)\s+(?:\w+\s+){0,1}?(?:inviat[oai]|pagat[oai]|trasferit[oai]|eseguit[oai]|effettuat[oai]|elaborat[oai]|completat[oai])\b`) },
  { re: rx(`${AT_START}(?:enviado|pagado|transferido|realizado|efectuado|pago|transferi|concluido|efetuado|inviato|pagato|eseguito|effettuato)\\b${WORD_BREAK}(?:${BOUNDARY}|$)`) },
  { re: rx(`${AT_START}(?:listo|hecho|completado|feito|pronto|fatto)\\b${WORD_BREAK}(?:${BOUNDARY}|$)`), strictOnly: true },
  // French
  { re: rx(String.raw`\b(?:j'ai|nous avons|on a|il a ete|elle a ete|ils ont ete|a ete|ont ete|est)\s+(?:\w+\s+){0,1}?(?:envoye|paye|vire|effectue|transfere|execute|traite|valide|approuve|regle|rembourse|debloque|libere)e?s?\b`) },
  { re: rx(String.raw`\b(?:paiement|virement|transfert|transaction|versement)\s+(?:est\s+|a ete\s+)?(?:effectue|envoye|reussi|termine|valide|execute|complete|confirme|traite)e?s?\b`) },
  { re: rx(`${AT_START}(?:envoye|paye|vire|effectue)e?\\b${WORD_BREAK}(?:${BOUNDARY}|$)`) },
  { re: rx(String.raw`\bc'est\s+fait\b|${AT_START}(?:fait|termine)e?\b${WORD_BREAK}(?:${BOUNDARY}|$)`), strictOnly: true },
  // Turkish
  { re: rx(String.raw`\b(?:gonderildi|odendi|aktarildi|islendi|yapildi|tamamlandi)\b|\b(?:gonderdim|odedim|aktardim|yaptim)\b`) },
  // Dutch
  { re: rx(String.raw`\b(?:ik heb|wij hebben)\s+(?:\w+\s+){0,2}?(?:verzonden|betaald|overgemaakt|verstuurd|overgeboekt|uitgevoerd|goedgekeurd)\b|\b(?:is|zijn|werd|werden)\s+(?:\w+\s+){0,1}?(?:verzonden|betaald|overgemaakt|verstuurd|overgeboekt|uitgevoerd)\b|\bbetaling\s+(?:is\s+)?(?:voltooid|geslaagd|uitgevoerd|verzonden)\b`) },
  { re: rx(`${AT_START}(?:klaar|gedaan)\\b${WORD_BREAK}(?:${BOUNDARY}|$)`), strictOnly: true },
  // German
  { re: rx(String.raw`\bich\s+habe\s+(?:\w+\s+){0,2}?(?:gesendet|uberwiesen|bezahlt|ausgefuhrt|abgeschickt|freigegeben|gezahlt|angewiesen|ubermittelt|verschickt|genehmigt|beglichen)\b`) },
  { re: rx(String.raw`\b(?:wurde|wurden|ist|sind)\s+(?:\w+\s+){0,1}?(?:gesendet|uberwiesen|bezahlt|ausgefuhrt|verarbeitet|gezahlt|abgeschickt|freigegeben|genehmigt|ubermittelt|verschickt)\b`) },
  { re: rx(String.raw`\bzahlung\s+(?:ist\s+|wurde\s+)?(?:erfolgt|abgeschlossen|ausgefuhrt|erfolgreich|gesendet|bestatigt)\b`) },
  { re: rx(`${AT_START}(?:gesendet|bezahlt|uberwiesen|ausgefuhrt)\\b${WORD_BREAK}(?:${BOUNDARY}|$)`) },
  { re: rx(`${AT_START}(?:erledigt|fertig)\\b${WORD_BREAK}(?:${BOUNDARY}|$)`), strictOnly: true },
];

export const WORD = String.raw`(?<![\p{L}\p{N}])`;

/** Languages in other scripts, read as written (not folded to Latin letters). */
export const NATIVE_CLAIMS: readonly ClaimPattern[] = [
  // Thai
  { re: /(?:\u0e2a\u0e48\u0e07|\u0e08\u0e48\u0e32\u0e22|\u0e42\u0e2d\u0e19|\u0e0a\u0e33\u0e23\u0e30|\u0e14\u0e33\u0e40\u0e19\u0e34\u0e19\u0e01\u0e32\u0e23)(?:\u0e40\u0e07\u0e34\u0e19)?(?:\u0e43\u0e2b\u0e49\S{0,10})?(?:\u0e40\u0e23\u0e35\u0e22\u0e1a\u0e23\u0e49\u0e2d\u0e22)?\u0e41\u0e25\u0e49\u0e27|(?:\u0e2a\u0e48\u0e07|\u0e08\u0e48\u0e32\u0e22|\u0e42\u0e2d\u0e19|\u0e0a\u0e33\u0e23\u0e30)\u0e40\u0e07\u0e34\u0e19?\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08/gu },
  { re: /\u0e40\u0e23\u0e35\u0e22\u0e1a\u0e23\u0e49\u0e2d\u0e22\u0e41\u0e25\u0e49\u0e27|\u0e2a\u0e33\u0e40\u0e23\u0e47\u0e08\u0e41\u0e25\u0e49\u0e27/gu, strictOnly: true },
  // Chinese, simplified and traditional
  { re: /(?:\u5df2\u7ecf?|\u5df2\u88ab|\u5df2\u6210\u529f|\u6210\u529f)(?:\u53d1\u9001|\u53d1\u51fa|\u652f\u4ed8|\u4ed8\u6b3e|\u8f6c\u8d26|\u8f6c\u5e10|\u6c47\u6b3e|\u6c47\u51fa|\u8f6c\u51fa|\u6253\u6b3e|\u5212\u8f6c|\u4ed8|\u8f6c|\u6c47|\u5904\u7406|\u6267\u884c|\u63d0\u4ea4|\u6279\u51c6|\u7b7e\u7f72|\u7ed3\u7b97|\u9000\u6b3e|\u5b58\u5165|\u767c\u9001|\u767c\u51fa|\u8f49\u5e33|\u8f49\u8cec|\u532f\u6b3e|\u532f\u51fa|\u8f49\u51fa|\u8655\u7406|\u57f7\u884c|\u6279\u6e96|\u7c3d\u7f72|\u7d50\u7b97)|(?:\u53d1\u9001|\u652f\u4ed8|\u4ed8\u6b3e|\u8f6c\u8d26|\u8f6c\u5e10|\u6c47\u6b3e|\u6253\u6b3e|\u4ea4\u6613|\u7ed3\u7b97|\u767c\u9001|\u8f49\u5e33|\u8f49\u8cec|\u532f\u6b3e|\u7d50\u7b97)(?:\u5df2)?\u6210\u529f|(?:\u652f\u4ed8|\u4ed8\u6b3e|\u8f6c\u8d26|\u6c47\u6b3e|\u8f6c\u5e10|\u8f49\u5e33|\u532f\u6b3e)\u5b8c\u6210|\u5df2\u5230\u8d26|\u5df2\u5230\u5e33/gu },
  { re: /\u641e\u5b9a|(?:\u5df2|\u5df2\u7ecf|\u5df2\u7d93)\u5b8c\u6210|\u5b8c\u6210\u4e86/gu, strictOnly: true },
  // Japanese
  { re: /(?:\u9001\u91d1|\u652f\u6255\u3044?|\u632f\u308a?\u8fbc\u307f?|\u9001\u4fe1|\u5165\u91d1|\u6c7a\u6e08|\u51e6\u7406|\u5b9f\u884c|\u627f\u8a8d|\u7f72\u540d|\u8fd4\u91d1|\u7cbe\u7b97|\u5f15\u304d\u843d\u3068\u3057)(?:\u3057|\u3055)?(?:\u307e\u3057\u305f|\u308c\u307e\u3057\u305f|\u6e08\u307f|\u6e08)/gu },
  { re: /(?:\u5b8c\u4e86|\u7d42\u4e86)(?:\u3057\u307e\u3057\u305f|\u3067\u3059|\u81f4\u3057\u307e\u3057\u305f)/gu, strictOnly: true },
  // Korean
  { re: /(?:\uc1a1\uae08|\uacb0\uc81c|\uc9c0\ubd88|\uc804\uc1a1|\uc785\uae08|\uc774\uccb4|\ucc98\ub9ac|\uc2b9\uc778|\ubc1c\uc1a1|\ubcf4\ub0b4)(?:\ud588|\ud558\uc600|\ub418\uc5c8|\ub410)|(?:\ubcf4\ub0c8|\uc9c0\ubd88\ud588|\uc1a1\uae08\ud588|\uacb0\uc81c\ud588|\uc785\uae08\ud588|\uc774\uccb4\ud588)|\uc644\ub8cc(?:\ub418\uc5c8|\ub410|\ud588)/gu },
  // Russian
  { re: new RegExp(`${WORD}(?:\u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d|\u043e\u043f\u043b\u0430\u0447\u0435\u043d|\u043f\u0435\u0440\u0435\u0432\u0435\u0434\u0435\u043d|\u043f\u0435\u0440\u0435\u0432\u0435\u0434\u0451\u043d|\u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d|\u043f\u0440\u043e\u0432\u0435\u0434\u0435\u043d|\u043f\u0440\u043e\u0432\u0435\u0434\u0451\u043d|\u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d|\u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d|\u0441\u043e\u0432\u0435\u0440\u0448\u0435\u043d|\u0441\u043e\u0432\u0435\u0440\u0448\u0451\u043d)[\u0430-\u044f\u0451]*`, 'gu') },
  { re: new RegExp(`${WORD}\u044f\\s+(?:\u0443\u0436\u0435\\s+)?(?:\u043e\u0442\u043f\u0440\u0430\u0432\u0438\u043b|\u043e\u043f\u043b\u0430\u0442\u0438\u043b|\u043f\u0435\u0440\u0435\u0432\u0435\u043b|\u043f\u0435\u0440\u0435\u0432\u0451\u043b|\u0432\u044b\u043f\u043e\u043b\u043d\u0438\u043b|\u043f\u0440\u043e\u0432\u0435\u043b|\u043f\u0440\u043e\u0432\u0451\u043b|\u0441\u043e\u0432\u0435\u0440\u0448\u0438\u043b|\u043e\u0434\u043e\u0431\u0440\u0438\u043b|\u043f\u043e\u0434\u043f\u0438\u0441\u0430\u043b)[\u0430-\u044f\u0451]*`, 'gu'), firstPerson: true },
  { re: new RegExp(`${WORD}\u043f\u043b\u0430\u0442\u0435\u0436[\u0430-\u044f\u0451]*\\s+(?:\u0431\u044b\u043b[\u0430]?\\s+)?(?:\u0432\u044b\u043f\u043e\u043b\u043d\u0435\u043d|\u043e\u0442\u043f\u0440\u0430\u0432\u043b\u0435\u043d|\u0437\u0430\u0432\u0435\u0440\u0448\u0435\u043d|\u0437\u0430\u0432\u0435\u0440\u0448\u0451\u043d|\u043f\u0440\u043e\u0448\u0435\u043b|\u043f\u0440\u043e\u0448\u0451\u043b|\u0443\u0441\u043f\u0435\u0448\u043d\u043e)`, 'gu') },
  { re: new RegExp(`^[^\u0430-\u044f\u0451]*(?:\u0433\u043e\u0442\u043e\u0432\u043e|\u0443\u0441\u043f\u0435\u0448\u043d\u043e)(?![\u0430-\u044f\u0451])`, 'gu'), strictOnly: true },
  // Hindi
  { re: /(?:\u092d\u0947\u091c\s*\u0926\u093f(?:\u092f\u093e|\u090f)|\u092d\u0947\u091c\s*\u0926\u0940|\u092d\u0941\u0917\u0924\u093e\u0928\s*(?:\u0939\u094b\s*\u0917\u092f\u093e|\u0915\u0930\s*\u0926\u093f\u092f\u093e)|\u091f\u094d\u0930\u093e\u0902\u0938\u092b\u0930\s*(?:\u0939\u094b\s*\u0917\u092f\u093e|\u0915\u0930\s*\u0926\u093f\u092f\u093e))/gu },
  // Arabic
  { re: /\u062a\u0645\s*(?:\u0627\u0644)?(?:\u0625\u0631\u0633\u0627\u0644|\u0627\u0631\u0633\u0627\u0644|\u062f\u0641\u0639|\u062a\u062d\u0648\u064a\u0644|\u0633\u062f\u0627\u062f|\u062a\u0646\u0641\u064a\u0630)|(?:\u0623\u0631\u0633\u0644\u062a|\u062f\u0641\u0639\u062a|\u062d\u0648\u0644\u062a|\u0633\u062f\u062f\u062a|\u0646\u0641\u0630\u062a)/gu },
];

/** Negation in the Latin-script claims (English and the Latin-script languages), read in the few words before the claim. */
export const NEGATION_LATIN = new RegExp(
  [
    String.raw`\b(?:not|never|nothing|none|neither|nor|without|unable|cannot|no longer|yet to)\b`,
    String.raw`n't`,
    String.raw`\bno\s+(?:payments?|money|funds?|transfers?|transactions?|payouts?|usdc)\b`,
    String.raw`\b(?:belum|tidak|tak|bukan|tiada|tanpa|hindi|wala|chua|khong|nada|ningun\w*|sin|rien|jamais|aucun\w*|pas|nao|nunca|nicht|nichts|kein\w*|ohne|nie|non|nulla|niente|mai|senza|degil|henuz|yok|niet|geen|niets|zonder)\b`,
    String.raw`\bno\s+(?:se|he|ha|han|hemos|fue|es|esta|hay)\b|\b(?:aun|todavia|ya)\s+no\b`,
  ].join('|'),
  'iu',
);

/** Negation in the claims in other scripts, read in the characters before the claim. */
export const NEGATION_NATIVE = new RegExp(
  [
    '\u672a|\u6ca1\u6709|\u6c92\u6709|\u5c1a\u672a|\u8fd8\u6ca1|\u9084\u6c92|\u5e76\u672a|\u4e26\u672a|\u307e\u305b\u3093|\u3066\u3044\u306a\u3044|\u307e\u3060|\uc54a|\ubabb\ud588|\uc544\uc9c1|\u0e22\u0e31\u0e07\u0e44\u0e21\u0e48|\u0e44\u0e21\u0e48|\u0644\u0645|\u0644\u0646|\u0644\u064a\u0633|\u0928\u0939\u0940\u0902|\u0928\u0939\u0940',
    '(?<![\u0430-\u044f\u0451])(?:\u043d\u0435|\u043d\u0438\u0447\u0435\u0433\u043e|\u043d\u0435\u0442|\u0431\u0435\u0437)(?![\u0430-\u044f\u0451])',
  ].join('|'),
  'iu',
);

export const CONDITION = new RegExp(
  [
    String.raw`\b(?:if|unless|once|until|till|after|when|whenever|as soon as|before|whether|upon|approves?|approving|signs?|waiting for|awaiting|pending)\b`,
    String.raw`\b(?:setelah|jika|kalau|apabila|sesudah|menunggu|persetujuan|kapag|pagkatapos|kung|hintay|sau khi|neu|doi|phe duyet)\b`,
    String.raw`\b(?:una vez|cuando|despues|tras|hasta|aprobacion|aprueba|esperando|pendiente|une fois|apres|quand|lorsque|des que|en attente|jusqu|approbation|depois|assim que|quando|aguardando|pendente|apos|nach|sobald|wenn|falls|warte|ausstehend|freigabe|dopo|fino|in attesa|approvazione|sonra|onay|beklen|nadat|zodra|wanneer|goedkeuring)\b`,
    '\u6279\u51c6\u540e|\u6279\u51c6\u5f8c|\u5ba1\u6279\u540e|\u5be9\u6279\u5f8c|\u4e4b\u540e|\u4e4b\u5f8c|\u7b49\u5f85|\u7b49\u5019|\u4e00\u65e6|\u5982\u679c|\u83b7\u6279|\u7372\u6279|\u6279\u51c6\u524d|\u5f85\u6279\u51c6|\u627f\u8a8d\u5f8c|\u627f\u8a8d\u3055\u308c\u6b21\u7b2c|\u627f\u8a8d\u3055\u308c\u308b\u307e\u3067|\u627f\u8a8d\u5f85\u3061|\u5834\u5408|\uc2b9\uc778 \ud6c4|\uc2b9\uc778\ub418\uba74|\uc2b9\uc778 \uc804|\ub300\uae30|\uacbd\uc6b0|\u0e2b\u0e25\u0e31\u0e07\u0e08\u0e32\u0e01|\u0e40\u0e21\u0e37\u0e48\u0e2d|\u0e16\u0e49\u0e32|\u0e2b\u0e32\u0e01|\u0e23\u0e2d|\u0e2d\u0e19\u0e38\u0e21\u0e31\u0e15\u0e34|\u043f\u043e\u0441\u043b\u0435|\u043a\u043e\u0433\u0434\u0430|\u0435\u0441\u043b\u0438|\u043e\u0436\u0438\u0434\u0430|\u0628\u0639\u062f|\u0639\u0646\u062f|\u0625\u0630\u0627|\u0639\u0646\u062f\u0645\u0627|\u0627\u0646\u062a\u0638\u0627\u0631|\u0645\u0648\u0627\u0641\u0642\u0629|\u0915\u0947 \u092c\u093e\u0926|\u0905\u0917\u0930|\u091c\u092c',
  ].join('|'),
  'iu',
);

/** Words that make a present-tense statement a rule rather than an event: "every release is approved by a person". */
export const GENERAL_RULE = /\b(?:every|each|any|always|usually|normally|typically|generally|whenever|monthly|weekly|daily|quarterly|annually|in seconds|within seconds)\b/i;

export const FIRST_PERSON_CONDITION = /\b(?:if|unless|whether)\b/i;

/** A modal or "to" straight before the claim: "will be sent", "can be paid", "to be released". */
export const MODAL_LEAD = /\b(?:will|would|'ll|can|could|should|may|might|must|shall|cannot|to|going to|gets?|about to)\s+(?:then\s+|also\s+|only\s+)?$/i;

/** A sentence that opens on a condition says what happens then, not what happened. */
export const OPENS_ON_CONDITION = /^[^a-z0-9]*(?:if|once|when|after|as soon as|until|unless|whenever|before|upon|assuming|provided|setelah|jika|una vez|cuando|apres|quand|une fois|depois|quando|sobald|wenn|nach|dopo)\b/;

/** A date or a record: the sentence reports what history shows, which a discussion turn may. */
export const PAST_ANCHOR = new RegExp(
  [
    String.raw`\b(?:yesterday|last (?:week|month|year|night|quarter)|\d+ (?:days?|weeks?|months?|years?) ago|on (?:mon|tues|wednes|thurs|fri|satur|sun)day)\b`,
    String.raw`\b\d{1,2}(?:st|nd|rd|th)? (?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b`,
    String.raw`\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}(?:st|nd|rd|th)?\b`,
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
    String.raw`\b(?:receipts?|history|statements?)\b`,
    '\\d{1,2}\u6708\\d{1,2}\u65e5|\\d{4}\u5e74',
  ].join('|'),
  'iu',
);

export const MONEY_TOPIC_ENGLISH = new RegExp(
  String.raw`\b(?:pay|pays|paying|paid|payments?|payouts?|payroll|transfers?|transferr?ed|transferring|wire|wired|wiring|remit\w*|settle\w*|disburs\w*|refunds?|reimburs\w*|withdraw\w*|swaps?|salary|salaries|batch(?:es)?|treasury|usdc|usdy|x402|allocate|redeem|sweep|invoices?|money|funds|bills?|owe|owes|owed|owing|top[- ]?ups?|send (?:it|this|that|money|funds|usdc|\$?\d)|sent (?:it|money|funds|usdc))\b`,
  'i',
);
/** The same talk of payments in the Latin-script languages (read without accents) and the others. */
export const MONEY_TOPIC_FOREIGN_LATIN = new RegExp(
  String.raw`\b(?:bayar\w*|kirim\w*|pembayaran|uang|duit|bayad|bayaran|padala|magbayad|magpadala|ipadala|thanh toan|chuyen tien|chuyen khoan|gui tien|tra tien|pag(?:a|ad[oa]s?|ar|ame|o|os|ue|amos|amento|amentos|are)|envi(?:a|ad[oa]|ar|o|e|ame|ei)|transfier\w*|transfir\w*|transferenc\w*|paiement|pay(?:er|ez)|envoi\w*|envoy\w*|virer|virez|virement|zahl\w*|bezahl\w*|uberweis\w*|senden|schick\w*|bonific\w*|invia\w*|trasfer\w*|odeme|gonder\w*|betaal\w*|betaling|overmaken|verstuur\w*)\b`,
  'i',
);
export const MONEY_TOPIC_FOREIGN_NATIVE = /\u652f\u4ed8|\u4ed8\u6b3e|\u4ed8\u94b1|\u4ed8\u9322|\u8f6c\u8d26|\u8f49\u5e33|\u8f6c\u94b1|\u6c47\u6b3e|\u532f\u6b3e|\u53d1\u9001|\u767c\u9001|\u6253\u6b3e|\u9001\u91d1|\u652f\u6255|\u632f\u8fbc|\u632f\u308a\u8fbc|\u6c7a\u6e08|\uacb0\uc81c|\uc1a1\uae08|\uc9c0\ubd88|\uc785\uae08|\uc774\uccb4|\ubcf4\ub0b4|\u0e2a\u0e48\u0e07\u0e40\u0e07\u0e34\u0e19|\u0e2a\u0e48\u0e07|\u0e08\u0e48\u0e32\u0e22|\u0e42\u0e2d\u0e19|\u0e0a\u0e33\u0e23\u0e30|\u043e\u043f\u043b\u0430\u0442|\u0437\u0430\u043f\u043b\u0430\u0442|\u043e\u0442\u043f\u0440\u0430\u0432|\u043f\u0435\u0440\u0435\u0432|\u043f\u043b\u0430\u0442\u0435\u0436|\u043f\u043b\u0430\u0442\u0438\u0442|\u062f\u0641\u0639|\u062a\u062d\u0648\u064a\u0644|\u0625\u0631\u0633\u0627\u0644|\u0627\u0631\u0633\u0627\u0644|\u0623\u0631\u0633\u0644|\u092d\u0941\u0917\u0924\u093e\u0928|\u092d\u0947\u091c|\u091f\u094d\u0930\u093e\u0902\u0938\u092b\u0930|\u092a\u0948\u0938\u0947/u;

// -- Added after the first review ---------------------------------------------
//
// Phrasings the first tables did not know, the three families of negation, and
// the small word lists the excuses use. Everything here is a plain list: the
// guard is a denylist and says so; the fixed line (see oxwal.ts) is what does
// not depend on it.

/** A past-tense claim word, for a sentence that opens on it. */
const OPENING_VERB = CLAIM_VERB;
/** What a sentence that opens on a claim verb goes on to name: "Sent 500 USDC", "Paid the invoice". */
const OPENING_OBJECT = String.raw`(?:\$\s?\d|\d|usdc?\b|usd\b|money\b|funds?\b|the\b|your\b|a\b|an\b|my\b|it\b|them\b|out\b|off\b)`;

/** The progressive ("Sending 500 USDC to Acme") unless it is plainly something else ("Paying attention", "Sending you ..."). */
const PROGRESSIVE_VERBS =
  'sending|paying|transferring|wiring|remitting|releasing|executing|processing|settling|disbursing|dispatching|refunding|swapping|withdrawing|depositing|submitting|approving|signing';
const PROGRESSIVE_NOT_A_PAYMENT = String.raw`(?!you\b|attention\b|close\b|special\b|heed\b|in\b|up\b|or\b|and\b|is\b|are\b|requires?\b|needs?\b|off\b|out\b)`;

export const REVIEWED_ENGLISH_CLAIMS: readonly ClaimPattern[] = [
  // A claim verb that opens the sentence and names what moved: "Sent 500 USDC to Acme.", "Allocated 500 USDC to treasury."
  { re: rx(String.raw`${AT_START}${OPENING_VERB}\s+${OPENING_OBJECT}`) },
  // Any claim verb as a whole sentence: "Wired.", "Approved.", "Signed and sealed.", "Payed!"
  { re: rx(String.raw`${AT_START}(?:(?:all|it is|it's|that's|everything is)\s+)?${CLAIM_VERB}(?:\s+(?:it|out|off|now|already|successfully|in full|and (?:sealed|delivered)))?${WORD_BREAK}(?:${BOUNDARY}|$)`), strictOnly: true },
  { re: rx(String.raw`\b(?:money|funds?|usdc|payment)\s+(?:has\s+|have\s+|was\s+|were\s+)(?:been\s+)?moved\b|\bwire\s+(?:sent|completed|done)\b`) },
  { re: rx(String.raw`\bpaid in full\b|\bmarked (?:it |this |that |the \w+ )?as (?:paid|sent|settled|done|complete|completed|processed)\b`) },
  // Money gone, left, or in someone's hands.
  { re: rx(String.raw`\b(?:money|funds?|usdc|payment)(?:'s|\s+is|\s+are|\s+has|\s+have)\s+(?:been\s+)?(?:gone|out)\b|\b(?:funds?|money|usdc)\s+(?:has\s+|have\s+)?left\s+(?:your|the|our)\s+(?:wallet|account|treasury|balance)\b`) },
  { re: rx(String.raw`(?<!\b(?:you|we|i|they)\s)\b(?:has|have|got)\s+(?:now\s+|already\s+|just\s+)?(?:the|your|their|its)\s+(?:money|funds|payment|usdc)\b`) },
  { re: rx(String.raw`\b(?:will have|should have|'ll have)\s+(?:the|your|their|its)\s+(?:money|funds|payment|usdc)\b`), strictOnly: true, wholeSentence: true },
  // A transaction reported as confirmed, made, out or in progress.
  { re: rx(String.raw`\b(?:tx|txn|transaction|transfer|payment)\s+(?:is\s+|was\s+|has\s+been\s+)?(?:confirmed|finali[sz]ed|succeeded|landed)\b`) },
  { re: rx(String.raw`\b(?:payments?|transfers?|payouts?|transactions?|deposits?|withdrawals?)\s+(?:(?:has|have|had|was|were)\s+)?(?:been\s+)?made\b`) },
  { re: rx(String.raw`\b(?:batch(?:es)?|payments?|payouts?|transfers?|transactions?|it|they)\s+(?:has\s+|have\s+|just\s+|all\s+)?(?:went|gone)\s+out\b`) },
  { re: rx(String.raw`\b(?:payment|transfer|payout|transaction|batch|it|that)\s+(?:is|are)\s+(?:currently\s+|now\s+)?in\s+progress\b`), strictOnly: true },
  { re: rx(String.raw`\b(?:it|that|this|payment|transfer|transaction)(?:'s|\s+is)\s+(?:now\s+|all\s+)?(?:gone|went)\s+through\b`) },
  { re: rx(String.raw`${AT_START}(?:it|that|this)\s+(?:worked|succeeded|went (?:through|well|fine|smoothly|ok|okay))\b`), strictOnly: true },
  { re: rx(String.raw`${AT_START}i\s+did\s+it\b`), strictOnly: true, firstPerson: true },
  { re: rx(String.raw`(?<!\b(?:you|we|i|your|our)\s)(?<!\b(?:you|we|i)\s(?:have|had|just)\s)\b(?:(?:has|have|had|just)\s+)?received\s+(?:\$\s?\d|\d[\d,.]*\s*(?:usdc|usd|php|myr|sgd|idr|vnd|thb|eur|gbp)?|the\s+(?:money|funds|payment|transfer|usdc))`), strictOnly: true },
  // The progressive as the opening of a sentence: "Sending 500 USDC to Acme.", "Paying Acme now."
  { re: rx(String.raw`${AT_START}(?:${PROGRESSIVE_VERBS})\s+${PROGRESSIVE_NOT_A_PAYMENT}\w`), strictOnly: true },
  // A promise that it is happening right now.
  { re: rx(String.raw`\b(?:i'll|i will|i'm going to|we'll|let me)\s+(?:just\s+)?(?:send|pay|transfer|wire|release|approve|sign|execute|process|settle|submit|dispatch|refund)\s+(?:it|this|that|them|the (?:money|funds|payment|transfer))\s+(?:right\s+)?(?:now|away|immediately|straight away|today|shortly)\b`), strictOnly: true, firstPerson: true },
  // A subject left out: "... and sent it."
  { re: rx(String.raw`\b(?:and|then|but)\s+(?:(?:just|already|then|also|finally|quickly)\s+)*(?:sent|paid|transferred|wired|released|approved|signed|settled|executed|processed|submitted)\s+(?:it|them|the|your|\$?\d|usdc|money|funds|payment)\b`), firstPerson: true },
  // "It's sent." (it is, or it has): a condition after it makes it a rule, one before it does not.
  { re: rx(String.raw`\b(?:it|that|this)'s\s+(?:(?:just|already|now|successfully|been)\s+)*${CLAIM_VERB}\b`), conditionAfter: true },
];

// -- Negation, by the language of the claim -----------------------------------

/** English words that negate a clause. "n't" endings are read separately. */
export const NEGATION_WORDS_ENGLISH: ReadonlySet<string> = new Set([
  'not', 'never', 'nothing', 'none', 'neither', 'nor', 'without', 'unable', 'cannot', 'no', 'nobody', 'nowhere',
  'dont', 'didnt', 'doesnt', 'cant', 'wont', 'hasnt', 'havent', 'hadnt', 'isnt', 'wasnt', 'werent', 'arent', 'couldnt', 'wouldnt', 'shouldnt',
]);

/**
 * Words that may stand between a negation and the claim it governs
 * ("has NOT yet BEEN sent", "NONE OF THE payments has been sent"). Anything
 * else between them ("Do not WORRY it has been sent") means the negation is
 * about something other than the claim.
 */
export const NEGATION_GLUE_ENGLISH: ReadonlySet<string> = new Set([
  'has', 'have', 'had', 'been', 'being', 'was', 'were', 'is', 'are', 'be', 'am', 'do', 'does', 'did', 'got', 'get', 'gets',
  'yet', 'ever', 'even', 'really', 'actually', 'just', 'already', 'fully', 'successfully', 'still', 'also', 'too', 'finally', 'safely', 'duly', 'now', 'anymore', 'longer', 'then', 'so',
  'it', 'they', 'this', 'that', 'these', 'those', 'the', 'a', 'an', 'any', 'of', 'one', 'i', 'we', 'you', 'zeke', 've',
  'payment', 'payments', 'transfer', 'transfers', 'money', 'funds', 'usdc', 'invoice', 'invoices', 'transaction', 'transactions', 'payout', 'payouts', 'batch', 'batches',
]);

/** Words that make a statement hypothetical or a question: "if it has been sent", "whether it was paid". */
export const HYPOTHETICAL = /\b(?:if|unless|whether|in case|assuming|supposing|suppose|even if|wondering)\b/i;
/** A condition that says when something happens ("once it has been approved"). */
export const OPENER_CONDITION = /\b(?:once|when|after|as soon as|upon|until|following)\b/i;
/** What an approval-state participle sounds like, at the start of a matched claim. */
export const APPROVAL_PARTICIPLE = /(?:approved|signed|authori[sz]ed)$/i;
/** A future or modal later in the sentence: "it has been approved, THEN it will be sent". */
export const MODAL_FUTURE = /\b(?:will|'ll|would|can|could|should|may|might|shall|going to)\b/i;
/** A sentence about a record rather than an act: "Invoice INV-1 is paid", "status: paid". */
export const RECORD_ANCHOR = /\binv(?:oice)?[-_ ]?[a-z0-9]*\d|\binvoices?\b|\bstatus\b|\breceipts?\b|\bhistory\b|\bstatements?\b|\bbills?\b/i;
/** A sentence that opens on a pronoun names no record of its own. */
export const PRONOUN_START = /^[^a-z0-9]*(?:it|that|this|they|he|she)\b/;
/** Words that make a present-tense statement about the way things are, not about an event. */
export const HABITUAL_WORDS = /\b(?:monthly|weekly|daily|quarterly|annually|in seconds|within seconds|typically)\b/i;

/**
 * Sentences that say what Zeke truly did: it handed a draft to people for
 * approval. Taken out of the text before the tables read it.
 */
export const TRUTHFUL_SPANS: readonly RegExp[] = [
  /\b(?:sent|submitted|forwarded|routed|passed|queued)\s+(?:(?:it|this|that|them|the \w+|a \w+|your \w+|my \w+)\s+){1,2}(?:\w+\s+){0,2}?(?:for\s+(?:your\s+|the\s+|team\s+)?(?:approval|review|sign[- ]?off)|to\s+(?:wallet|(?:your\s+|the\s+)?approvers?)\b)/g,
  /\b(?:sent|submitted|forwarded|routed)\s+for\s+(?:your\s+|the\s+)?(?:approval|review|sign[- ]?off)\b/g,
];
