import assert from "node:assert/strict";
import { test } from "node:test";
import { addressesFromSdn, isListed } from "./server/sanctions.ts";

const xml = `
<FeatureType ID="345" FeatureTypeGroupID="1">Digital Currency Address - ETH</FeatureType>
<FeatureType ID="887" FeatureTypeGroupID="1">Digital Currency Address - USDT</FeatureType>
<FeatureType ID="1" FeatureTypeGroupID="1">Digital Currency Address - XBT</FeatureType>
<FeatureType ID="1167" FeatureTypeGroupID="1">Digital Currency Address - SOL</FeatureType>
<Feature ID="1" FeatureTypeID="345">
  <VersionDetail DetailTypeID="1432">0xAbCd000000000000000000000000000000000001</VersionDetail>
</Feature>
<Feature ID="2" FeatureTypeID="887">
  <VersionDetail DetailTypeID="1432">0x2222222222222222222222222222222222222222</VersionDetail>
</Feature>
<Feature ID="3" FeatureTypeID="887">
  <VersionDetail DetailTypeID="1432">TNotAnEthereumAddress</VersionDetail>
</Feature>
<Feature ID="4" FeatureTypeID="1">
  <VersionDetail DetailTypeID="1432">1BitcoinAddress</VersionDetail>
</Feature>
<Feature ID="5" FeatureTypeID="1167">
  <VersionDetail DetailTypeID="1432">SoLanaAddress111</VersionDetail>
</Feature>
`;

test("the SDN extract keeps ETH and SOL addresses and ignores the others", () => {
  const list = addressesFromSdn(xml, 1);
  assert.equal(isListed("sepolia", "0xabcd000000000000000000000000000000000001", list), true);
  assert.equal(isListed("sepolia", "0x2222222222222222222222222222222222222222", list), true);
  assert.equal(isListed("sepolia", "0x3333333333333333333333333333333333333333", list), false);
  assert.equal(isListed("devnet", "SoLanaAddress111", list), true);
  assert.equal(isListed("devnet", "solanaaddress111", list), false);
  assert.equal(list.eth.includes("1bitcoinaddress"), false);
  assert.equal(list.sol.includes("TNotAnEthereumAddress"), false);
});

test("a file without the currency types is refused", () => {
  assert.throws(() => addressesFromSdn("<FeatureType ID=\"1\">Name</FeatureType>", 1), /format was not recognized/);
});
