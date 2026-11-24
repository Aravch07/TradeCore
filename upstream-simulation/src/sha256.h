/*
 * sha256.h - SHA-256 hash (FIPS 180-4), used to store passwords as salted,
 * iterated hashes instead of plain text.
 */
#ifndef TC_SHA256_H
#define TC_SHA256_H

#include <stddef.h>
#include <stdint.h>

typedef struct {
    uint32_t state[8];
    uint64_t bits;
    uint8_t  buf[64];
    size_t   used;
} Sha256;

void sha256_init(Sha256 *c);
void sha256_update(Sha256 *c, const void *data, size_t len);
void sha256_final(Sha256 *c, uint8_t out[32]);
void sha256(const void *data, size_t len, uint8_t out[32]);

#endif
