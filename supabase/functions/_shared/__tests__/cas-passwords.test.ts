import { buildCASPasswordAttempts } from '../cas-passwords';

describe('CAS password attempt order', () => {
  it('uses saved PAN first and PAN plus DOB only as the second attempt', () => {
    expect(buildCASPasswordAttempts(
      { pan: 'abcpe1234f', dob: '1990-01-02' },
      null,
    )).toEqual({
      primary: 'ABCPE1234F',
      depositoryFallback: 'ABCPE1234F02011990',
      mode: 'profile',
    });
  });

  it('uses only PAN when DOB is missing or malformed', () => {
    expect(buildCASPasswordAttempts({ pan: 'ABCPE1234F', dob: null }, null))
      .toEqual({
        primary: 'ABCPE1234F',
        depositoryFallback: null,
        mode: 'profile',
      });
    expect(buildCASPasswordAttempts({ pan: 'ABCPE1234F', dob: '02-01-1990' }, null))
      .toEqual({
        primary: 'ABCPE1234F',
        depositoryFallback: null,
        mode: 'profile',
      });
  });

  it('uses a custom override exclusively', () => {
    expect(buildCASPasswordAttempts(
      { pan: 'ABCPE1234F', dob: '1990-01-02' },
      'different-password',
    )).toEqual({
      primary: 'different-password',
      depositoryFallback: null,
      mode: 'custom',
    });
  });
});
